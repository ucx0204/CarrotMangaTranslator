import { PassThrough } from "node:stream";
import {
  ChildProcess,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { GrokAcpClient } from "../src/main/grok/grokAcpClient";
import {
  grokAccountFromInitialization,
  grokInitialization,
  type startGrokRuntime,
} from "../src/main/grok/grokRuntime";
import { GrokChatRuntime } from "../src/main/chat/grokChatRuntime";
import {
  readGrokAccount,
  authenticateGrok,
} from "../src/main/grok/grokAccount";
import type { AppPaths } from "../src/main/appPaths";
import type { ChatSession } from "../src/shared/chatTypes";

afterEach(() => vi.useRealTimers());
it("lets a real worker finish after EOF before considering force termination", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),40))",
    ],
    { stdio: "pipe", windowsHide: true },
  );
  const client = new GrokAcpClient(child);
  await client.close();
  expect(child.exitCode).toBe(0);
});
it("terminates a real unresponsive worker after the graceful shutdown deadline", async () => {
  const client = GrokAcpClient.start(
    process.execPath,
    ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
    process.cwd(),
    process.env,
  );
  await expect(client.close()).resolves.toBeUndefined();
}, 10_000);
function transport() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    exitCode: null,
    signalCode: null,
  }) as ChildProcessWithoutNullStreams & { stdout: PassThrough };
  const client = new GrokAcpClient(child);
  const written: Record<string, unknown>[] = [];
  child.stdin.on("data", (chunk: Buffer) =>
    written.push(JSON.parse(chunk.toString())),
  );
  return { child, client, written };
}
it("handles fragmented ACP responses, notifications and reverse requests", async () => {
  const { child, client, written } = transport();
  const notify = vi.fn();
  client.onNotification = notify;
  const response = client.request("initialize", {});
  expect(written[0]).toMatchObject({ jsonrpc: "2.0", id: 1 });
  child.stdout.write('{"id":1,"result":{"ready":');
  child.stdout.write(
    'true}}\n{"method":"session/update","params":{"text":"한글"}}\n',
  );
  await expect(response).resolves.toEqual({ ready: true });
  expect(notify).toHaveBeenCalledWith("session/update", { text: "한글" });
  client.onRequest = async () => ({ allowed: true });
  child.stdout.write('{"id":"reverse","method":"permission","params":{}}\n');
  await Promise.resolve();
  expect(written.at(-1)).toMatchObject({
    id: "reverse",
    result: { allowed: true },
  });
  await client.close();
});
it("rejects pending requests on malformed output and owns later pipe errors", async () => {
  const { child, client } = transport();
  const failed = vi.fn();
  client.onFailure = failed;
  const result = client.request("initialize", {});
  child.stdout.write("not json\n");
  await expect(result).rejects.toThrow("해석");
  child.stdin.emit("error", new Error("late pipe error"));
  expect(failed).toHaveBeenCalledOnce();
  await expect(client.request("later", {})).rejects.toThrow("해석");
  await client.close();
});
it("settles timeouts, RPC errors, unsupported reverse calls and close", async () => {
  vi.useFakeTimers();
  const { child, client, written } = transport();
  const timeout = expect(client.request("slow", {}, 10)).rejects.toThrow(
    "초과",
  );
  await vi.advanceTimersByTimeAsync(10);
  await timeout;
  const error = client.request("bad", {});
  child.stdout.write('{"id":2,"error":{"message":"rejected"}}\n');
  await expect(error).rejects.toThrow("rejected");
  child.stdout.write('{"id":"x","method":"fs/read_text_file","params":{}}\n');
  await Promise.resolve();
  expect(written.at(-1)).toMatchObject({ error: { code: -32601 } });
  const pending = expect(client.request("pending", {})).rejects.toThrow(
    "닫았습니다",
  );
  await client.close();
  await pending;
  await client.close();
});
it("never installs or starts authentication while polling or logging out on a fresh install", async () => {
  const paths = { dataRoot: "C:/nonexistent-grok-test-data-root" } as AppPaths;
  expect(await readGrokAccount(paths)).toMatchObject({
    authenticated: false,
    runtimeInstalled: false,
    models: [],
  });
  expect(await authenticateGrok(paths, "logout")).toMatchObject({
    runtimeInstalled: false,
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    authenticateGrok(paths, "login", controller.signal),
  ).rejects.toThrow();
});
it("uses the official advertised model catalogue and cached login without exposing account secrets", () => {
  const init = grokInitialization.parse({
    authMethods: [{ id: "cached_token" }],
    _meta: {
      agentVersion: "1.0.77",
      modelState: {
        currentModelId: "grok-4.7",
        availableModels: [
          {
            modelId: "grok-4.7",
            name: "Grok 4.7",
            _meta: {
              reasoningEffort: "high",
              reasoningEfforts: [{ value: "low" }, { value: "high" }],
            },
          },
        ],
      },
    },
  });
  expect(grokAccountFromInitialization(init)).toEqual({
    authenticated: true,
    runtimeInstalled: true,
    version: "1.0.77",
    models: [
      {
        id: "grok-4.7",
        displayName: "Grok 4.7",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
        isDefault: true,
      },
    ],
  });
  expect(
    grokAccountFromInitialization({ authMethods: [{ id: "grok.com" }] })
      .authenticated,
  ).toBe(false);
});

function chat(authenticated = true) {
  const events = { notification: vi.fn(), question: vi.fn(), failed: vi.fn() };
  const client = {
    request: vi.fn(
      async (
        method: string,
        _params: unknown,
        _timeout?: number,
      ): Promise<unknown> =>
        method === "session/new"
          ? { sessionId: "native" }
          : method === "session/prompt"
            ? { stopReason: "end_turn", _meta: { totalTokens: 42 } }
            : {},
    ),
    onNotification: (_method: string, _value: unknown) => undefined as void,
    onRequest: async (
      _method: string,
      _value: unknown,
    ): Promise<unknown> => ({}),
    onFailure: (_error: Error) => undefined as void,
    close: vi.fn(async () => undefined),
  };
  const start = vi.fn(async () => ({
    client,
    cwd: "isolated",
    initialization: {
      authMethods: [{ id: authenticated ? "cached_token" : "grok.com" }],
    },
  })) satisfies typeof startGrokRuntime;
  const runtime = new GrokChatRuntime(
    {} as AppPaths,
    { url: "http://127.0.0.1/mcp", token: "fixture-token" },
    events,
    start,
  );
  const session = {
    nativeThreadId: null,
    model: null,
    effort: null,
  } as ChatSession;
  return { runtime, client, events, session, start };
}
it("sends real ACP images, model and effort; resumes without replaying the transcript", async () => {
  const { runtime, client, events, session } = chat();
  expect(await runtime.prepare(session)).toBe("native");
  expect(client.request).toHaveBeenCalledWith(
    "session/new",
    expect.objectContaining({
      mcpServers: [
        expect.objectContaining({
          headers: [{ name: "Authorization", value: "Bearer fixture-token" }],
        }),
      ],
    }),
  );
  await runtime.send(
    "message",
    [
      { type: "text", text: "read this" },
      { type: "image", url: "data:image/png;base64,aGVsbG8=" },
    ],
    "grok-4.7",
    "high",
  );
  expect(client.request).toHaveBeenCalledWith(
    "session/prompt",
    {
      sessionId: "native",
      prompt: [
        { type: "text", text: "read this" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    },
    expect.any(Number),
  );
  expect(client.request).toHaveBeenCalledWith("session/set_model", {
    sessionId: "native",
    modelId: "grok-4.7",
  });
  expect(client.request).toHaveBeenCalledWith("session/set_config_option", {
    sessionId: "native",
    configId: "reasoning_effort",
    value: "high",
  });
  expect(events.notification).toHaveBeenCalledWith({
    kind: "usage",
    totalTokens: 42,
  });
  await runtime.close();
  await runtime.prepare({ ...session, nativeThreadId: "native" });
  expect(client.request).toHaveBeenCalledWith(
    "session/load",
    expect.objectContaining({ sessionId: "native" }),
  );
  await runtime.close();
});
it("gates native capabilities, allows only Carrot MCP permissions, and routes user questions", async () => {
  const { runtime, client, session, events } = chat();
  await runtime.prepare(session);
  const permission = {
    sessionId: "native",
    toolCall: { rawInput: { tool_name: "carrot__list_works" } },
    options: [
      { optionId: "yes", kind: "allow_once" },
      { optionId: "no", kind: "reject_once" },
    ],
  };
  expect(
    await client.onRequest("session/request_permission", permission),
  ).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  expect(
    await client.onRequest("session/request_permission", {
      ...permission,
      toolCall: { rawInput: { tool_name: "bash" } },
    }),
  ).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  await expect(client.onRequest("fs/read_text_file", {})).rejects.toThrow(
    "지원하지",
  );
  const answer = client.onRequest("_x.ai/ask_user_question", {
    sessionId: "native",
    toolCallId: "q",
    questions: [{ question: "Which page?", options: [{ label: "First" }] }],
  });
  expect(events.question).toHaveBeenCalledWith(
    expect.objectContaining({ id: "q" }),
  );
  runtime.answer("q", { "Which page?": "First" });
  expect(await answer).toEqual({
    outcome: "accepted",
    answers: { "Which page?": ["First"] },
  });
  const cancelled = client.onRequest("_x.ai/ask_user_question", {
    sessionId: "native",
    toolCallId: "q2",
    questions: [],
  });
  await runtime.stop();
  expect(await cancelled).toEqual({ outcome: "cancelled" });
  expect(() => runtime.answer("q2", {})).toThrow("더 이상");
});
it("preserves text and tool ordering, ignores reasoning and other sessions", async () => {
  const { runtime, client, session, events } = chat();
  await runtime.prepare(session);
  const emit = (update: unknown, sessionId = "native") =>
    client.onNotification("session/update", { sessionId, update });
  emit({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "private reasoning" },
  });
  emit(
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ignored" },
    },
    "other",
  );
  expect(events.notification).not.toHaveBeenCalled();
  emit({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hello" },
  });
  emit({
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    title: "use_tool",
    rawInput: { tool_name: "carrot__list_works", tool_input: {} },
  });
  emit({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool",
    status: "completed",
    rawOutput: { content: [] },
  });
  expect(events.notification).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "text", text: "Hello", done: true }),
  );
  expect(events.notification).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "tool", name: "list_works" }),
  );
  await runtime.close();
});
it("rejects missing login and malformed images; cancelled turns cannot complete later", async () => {
  const missing = chat(false);
  await expect(missing.runtime.prepare(missing.session)).rejects.toThrow(
    "로그인",
  );
  expect(missing.client.request).not.toHaveBeenCalledWith(
    "authenticate",
    expect.anything(),
  );
  const { runtime, client, session, events } = chat();
  await runtime.prepare(session);
  await expect(
    runtime.send(
      "bad",
      [{ type: "image", url: "file:///secret.png" }],
      null,
      null,
    ),
  ).rejects.toThrow("형식");
  let resolve: (value: unknown) => void = () => undefined;
  client.request.mockImplementation(
    async () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const sending = runtime.send(
    "cancel",
    [{ type: "text", text: "hello" }],
    null,
    null,
  );
  await runtime.stop();
  resolve({ stopReason: "end_turn" });
  await sending;
  expect(events.notification).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "finished" }),
  );
});
