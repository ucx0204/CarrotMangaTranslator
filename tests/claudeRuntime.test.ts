import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import type { ChatSession } from "../src/shared/chatTypes";
import { ClaudeChatRuntime } from "../src/main/chat/claudeChatRuntime";
import { runClaudeCompletion } from "../src/main/claude/claudeCompletion";
import { startClaudeRuntime } from "../src/main/claude/claudeRuntime";
import { createChatService } from "../src/main/chat/createChatService";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => process.cwd() },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  sdk.query.mockReset();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "carrot-claude-test-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const output = new Readable({ objectMode: true, read() {} });
  const stream = Object.assign(output, {
    initializationResult: vi.fn(async () => ({})),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    close: vi.fn(() => output.push(null)),
  });
  sdk.query.mockReturnValue(stream);
  const paths = {
    dataRoot: root,
    isPackaged: false,
    resourcesDir: root,
  } as AppPaths;
  const events = { notification: vi.fn(), question: vi.fn(), failed: vi.fn() };
  const runtime = new ClaudeChatRuntime(
    paths,
    { url: "http://127.0.0.1:1234/mcp", token: "test-private" },
    events,
  );
  disposals.push(() => runtime.close());
  const session: ChatSession = {
    version: 1,
    id: "test",
    runtime: "claude",
    nativeThreadId: null,
    title: "test",
    model: "sonnet",
    effort: "high",
    state: "idle",
    createdAt: 1,
    updatedAt: 1,
    items: [],
    checkpoint: [],
    question: null,
  };
  return { root, stream, output, paths, events, runtime, session };
}
it("respects an explicitly provided executable without invoking automatic installation", async () => {
  const f = await fixture();
  const runtime = await startClaudeRuntime(
    { ...f.paths, isPackaged: true },
    { pathToClaudeCodeExecutable: "custom-claude" },
  );
  expect(sdk.query.mock.calls[0][0].options.pathToClaudeCodeExecutable).toBe(
    "custom-claude",
  );
  runtime.close();
});
it("stops queued input and resumes the same native conversation without changing the active model", async () => {
  const f = await fixture();
  const thread = await f.runtime.prepare(f.session);
  const request = sdk.query.mock.calls[0][0];
  await f.runtime.send(
    "m1",
    [{ type: "text", text: "translate" }],
    "sonnet",
    "high",
  );
  const queued = f.runtime.send(
    "m2",
    [{ type: "text", text: "continue" }],
    "opus",
    "max",
  );
  await f.runtime.stop();
  await queued;
  expect(f.stream.setModel).toHaveBeenCalledTimes(1);
  expect(f.stream.close).toHaveBeenCalled();
  expect(request.options).toMatchObject({
    sessionId: thread,
    persistSession: true,
    strictMcpConfig: true,
    tools: ["AskUserQuestion"],
  });
  expect(request.options.mcpServers.carrot.headers.Authorization).toBe(
    "Bearer test-private",
  );
  expect(f.events.failed).not.toHaveBeenCalled();
});
it("rejects non-MCP tools and resolves already-cancelled questions", async () => {
  const f = await fixture();
  await f.runtime.prepare({
    ...f.session,
    nativeThreadId: "saved",
    items: [
      {
        id: "sent",
        role: "user",
        text: "previous",
        state: "completed",
        createdAt: 1,
        delivery: "sent",
      },
    ],
  });
  const options = sdk.query.mock.calls[0][0].options;
  expect(options.resume).toBe("saved");
  const control = { toolUseID: "q", signal: AbortSignal.abort() };
  expect((await options.canUseTool("Bash", {}, control)).behavior).toBe("deny");
  expect(
    (await options.canUseTool("mcp__carrot__carrot_list_library", {}, control))
      .behavior,
  ).toBe("allow");
  expect(
    (
      await options.canUseTool(
        "AskUserQuestion",
        { questions: [{ question: "which?" }] },
        control,
      )
    ).behavior,
  ).toBe("deny");
});

it("passes user answers to Claude's native question and rejects stale answers", async () => {
  const f = await fixture();
  await f.runtime.prepare(f.session);
  const options = sdk.query.mock.calls[0][0].options;
  const questions = [
    {
      question: "어느 작품?",
      options: [{ label: "A", description: "첫 작품" }],
    },
  ];
  const pending = options.canUseTool(
    "AskUserQuestion",
    { questions },
    { toolUseID: "question", signal: new AbortController().signal },
  );
  expect(f.events.question).toHaveBeenCalledWith({
    id: "question",
    questions: [{ ...questions[0], id: "어느 작품?" }],
  });
  f.runtime.answer("question", { "어느 작품?": "A" });
  expect(await pending).toEqual({
    behavior: "allow",
    updatedInput: { questions, answers: { "어느 작품?": "A" } },
  });
  expect(() => f.runtime.answer("question", {})).toThrow(
    "응답을 기다리지 않습니다",
  );
});
it("does not push after cancellation races with model selection", async () => {
  const f = await fixture();
  await f.runtime.prepare(f.session);
  let release!: () => void;
  f.stream.setModel.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const send = f.runtime.send(
    "m",
    [{ type: "text", text: "work" }],
    "sonnet",
    "high",
  );
  await f.runtime.stop();
  release();
  await send;
  expect(f.events.notification).not.toHaveBeenCalledWith({ kind: "started" });
});
it("closes isolated tasks and preserves structured output", async () => {
  const f = await fixture();
  const request = {
    model: "sonnet",
    instructions: "translate",
    input: [{ type: "text" as const, text: "hello" }],
  };
  const completed = runClaudeCompletion(f.paths, request);
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());
  f.output.push({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: { text: "안녕" },
    usage: {},
    modelUsage: {},
    session_id: "s",
    uuid: "r",
  });
  expect(await completed).toMatchObject({
    text: '{"text":"안녕"}',
    sessionId: "s",
  });
  expect(f.stream.close).toHaveBeenCalled();
});

it("returns a stream the existing translation reader accepts and rejects browser origins", async () => {
  const f = await fixture();
  const { startClaudeEndpoint } =
    await import("../src/main/claude/claudeEndpoint");
  const { requestResponsesText } = createRequire(import.meta.url)(
    "../src/main/runtime/transport/responses-completion.cjs",
  ) as {
    requestResponsesText: (
      server: { baseUrl: string },
      options: object,
      body: object,
      summary: object,
    ) => Promise<{ outputText: string }>;
  };
  const endpoint = await startClaudeEndpoint(f.paths);
  disposals.push(() => endpoint.close());
  const denied = await fetch(endpoint.baseUrl + "/responses", {
    method: "POST",
    headers: { Origin: "https://example.com" },
    body: "{}",
  });
  expect(denied.status).toBe(403);
  expect(sdk.query).not.toHaveBeenCalled();
  const result = requestResponsesText(
    endpoint,
    { modelProvider: "claude-code" },
    {
      model: "sonnet",
      input: [
        { role: "user", content: [{ type: "input_text", text: "translate" }] },
      ],
    },
    {},
  );
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());
  f.output.push({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"text":"안녕"}',
    usage: { input_tokens: 1, output_tokens: 2 },
    modelUsage: {},
    session_id: "s",
    uuid: "r",
  });
  expect((await result).outputText).toBe('{"text":"안녕"}');
});

it("cancels initialization without creating a false failed turn or resuming an unsent session", async () => {
  const f = await fixture();
  let reject!: (error: Error) => void;
  f.stream.initializationResult.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const prepared = f.runtime.prepare({
    ...f.session,
    nativeThreadId: "unused",
    items: [
      {
        id: "pending",
        role: "user",
        text: "work",
        state: "completed",
        createdAt: 1,
        delivery: "pending",
      },
    ],
  });
  await vi.waitFor(() =>
    expect(f.stream.initializationResult).toHaveBeenCalled(),
  );
  expect(sdk.query.mock.calls[0][0].options).toMatchObject({
    sessionId: "unused",
  });
  expect(sdk.query.mock.calls[0][0].options.resume).toBeUndefined();
  await f.runtime.stop();
  reject(new Error("cancelled"));
  await expect(prepared).resolves.toBe("unused");
  expect(f.events.failed).not.toHaveBeenCalled();
});
it("accepts one native completion for coalesced follow-up messages", async () => {
  const f = await fixture();
  await f.runtime.prepare(f.session);
  await f.runtime.send(
    "m1",
    [{ type: "text", text: "first" }],
    "sonnet",
    "high",
  );
  await f.runtime.send(
    "m2",
    [{ type: "text", text: "follow-up" }],
    "sonnet",
    "high",
  );
  f.events.notification.mockClear();
  f.output.push({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  await vi.waitFor(() =>
    expect(f.events.notification).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "finished", status: "completed" }),
    ),
  );
});

it.each(["claude", "codex", "grok"] as const)(
  "connects the shared MCP with %s identity and releases failed starts",
  async (provider) => {
    const f = await fixture();
    // A legacy packaged runtime fixture; SDK execution is mocked, so this
    // integration test must not download executables from the network.
    await mkdir(join(f.root, "claude"), { recursive: true });
    await writeFile(
      join(
        f.root,
        "claude",
        process.platform === "win32" ? "claude.exe" : "claude",
      ),
      "fixture",
    );
    await mkdir(join(f.root, "c", "bin"), { recursive: true });
    await writeFile(
      join(
        f.root,
        "c",
        "bin",
        process.platform === "win32" ? "codex.exe" : "codex",
      ),
      "fixture",
    );
    await writeFile(
      join(f.root, "c", "codex-package.json"),
      JSON.stringify({ version: "0.167.0" }),
    );
    const close = vi.fn();
    const connectChat = vi.fn(async () => ({
      url: "http://127.0.0.1:1234/mcp",
      token: "private",
      close,
      cancelOperations: async () => {},
    }));
    const publish = vi.fn();
    const service = createChatService({
      paths: { ...f.paths, isPackaged: true },
      appVersion: "test",
      mcp: { connectChat },
      publish,
      reportError: vi.fn(),
    });
    disposals.push(() => service.dispose());
    const session = await service.create(provider);
    if (provider === "codex")
      await writeFile(join(f.root, "chat", "runtime"), "not a directory");
    await service.send({
      sessionId: session.id,
      messageId: randomUUID(),
      text: "inspect",
      context: {
        workId: null,
        workTitle: null,
        chapterId: null,
        chapterTitle: null,
        pageId: null,
        pageNumber: null,
        blockIds: [],
      },
      imageIds: [],
      model: "sonnet",
      effort: "high",
    });
    await vi.waitFor(() =>
      expect(connectChat).toHaveBeenCalledWith(
        session.id,
        expect.any(Function),
        { claude: "Claude Code", codex: "Codex", grok: "Grok Build" }[provider],
      ),
    );
    if (provider === "claude") {
      await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());
      await service.dispose();
    } else if (provider === "grok") {
      await vi.waitFor(async () =>
        expect((await service.read(session.id)).state).toBe("failed"),
      );
      expect(sdk.query).not.toHaveBeenCalled();
      await service.dispose();
    } else {
      await vi.waitFor(() => expect(close).toHaveBeenCalled());
      expect((await service.read(session.id)).state).toBe("failed");
    }
    expect(close).toHaveBeenCalled();
  },
);

it.each([undefined, "max"] as const)(
  "routes model probes through Claude Responses with %s effort and closes the endpoint",
  async (effort) => {
    const f = await fixture();
    const {
      startModelTestServerWithRetry,
      stopModelTestServer,
      productionModelTestEndpointRuntime,
    } = await import("../src/main/ipc/settingsModelTestServer");
    const { buildBaseTranslationOptions, resolveDefaultAppSettings } =
      await import("../src/main/appSettings");
    const { getAppPaths } = await import("../src/main/appPaths");
    const options = buildBaseTranslationOptions({
      jobId: "probe",
      runDir: f.root,
      paths: getAppPaths(),
      settings: {
        ...resolveDefaultAppSettings({}),
        modelProvider: "claude-code",
      },
      env: {},
    });
    options.claudeEffort = effort;
    const runtime =
      {} as import("../src/main/simplePageRuntime").SimplePageRuntime;
    const { server } = await startModelTestServerWithRetry(
      runtime,
      options,
      vi.fn(),
      productionModelTestEndpointRuntime,
    );
    disposals.push(() =>
      stopModelTestServer(
        runtime,
        server,
        productionModelTestEndpointRuntime,
        options,
        vi.fn(),
      ),
    );
    const { testModelReply } = createRequire(import.meta.url)(
      "../src/main/runtime/transport/model-probe.cjs",
    );
    const pending = testModelReply(server, options);
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());
    expect(sdk.query.mock.calls[0][0].options.effort).toBe(effort ?? "high");
    f.output.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "model test ok",
      usage: {},
      modelUsage: {},
      session_id: "s",
      uuid: "r",
    });
    expect(await pending).toMatchObject({
      outputText: "model test ok",
      launchTarget: { launchMode: "claude-code" },
    });
  },
);
