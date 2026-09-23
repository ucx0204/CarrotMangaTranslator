import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodexImageResponse } from "../src/main/codexImageResponses";
import { readCodexImageResponse } from "../src/main/codexImageResponseStream";
import { isSexualImageRefusal } from "../src/main/codexImageModeration";
import { startCodexImageSession } from "../src/main/codexImageSession";
import { CodexAppServerClient } from "../src/main/codexAppServerClient";
import { withApprovedImageRedactions } from "../src/main/imageRedactionContext";
import { resolveDefaultAppSettings } from "../src/main/settings/appSettingsDefaults";
import type { AppPaths } from "../src/main/appPaths";
import type { CodexAppServerTurnRequest } from "../src/main/codexAppServerProtocol";

vi.mock("electron", () => ({ app: { getVersion: () => "test" } }));
let directory: string;
const http = vi.fn<typeof fetch>();
const image = {
  type: "image_generation_call",
  id: "image-1",
  status: "completed",
  result: "aW1hZ2U=",
  revised_prompt: "원문",
};
const request: CodexAppServerTurnRequest = {
  model: "gpt-6-astra",
  effort: "low",
  instructions: "Generate once.",
  cwd: ".",
  input: [
    { type: "text", text: "edit the supplied image" },
    {
      type: "image",
      url: "data:image/png;base64,aW1hZ2U=",
      detail: "original",
    },
  ],
};
const completed = {
  type: "response.completed",
  response: {
    id: "r1",
    status: "completed",
    model: "gpt-6-astra",
    output: [image],
    usage: { total_tokens: 12 },
  },
};

function stream(events: unknown[], fragmented = false, terminated = true) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}`).join("\r\n\r\n") +
      (terminated ? "\r\n\r\ndata: [DONE]\r\n\r\n" : ""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        const size = fragmented ? 7 : bytes.length;
        for (let i = 0; i < bytes.length; i += size)
          controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      },
    }),
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codex-image-response-"));
  await mkdir(join(directory, "codex"));
  await writeFile(
    join(directory, "codex", "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "test-secret", account_id: "test-account" },
    }),
  );
  http.mockReset();
  vi.stubGlobal("fetch", http);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const)(
  "sends selected %s with independent controller and preserved image inputs",
  async (model) => {
    http.mockResolvedValue(stream([completed], true));
    const result = await runCodexImageResponse({ dataRoot: directory }, model, {
      ...request,
      imageGenerationSize: "1024x1024",
    });
    const [url, options] = http.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(options).toMatchObject({
      redirect: "error",
      headers: {
        Authorization: "Bearer test-secret",
        "ChatGPT-Account-Id": "test-account",
      },
    });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      model: "gpt-6-astra",
      reasoning: { effort: "low" },
      store: false,
      tools: [{ type: "image_generation", model, size: "1024x1024" }],
      input: [
        {
          content: [
            {
              type: "input_text",
              text:
                request.input[0].type === "text" ? request.input[0].text : "",
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aW1hZ2U=",
              detail: "original",
            },
          ],
        },
      ],
    });
    expect(JSON.parse(result.text)).toMatchObject({
      result: image.result,
      revisedPrompt: "원문",
    });
    expect(result).toMatchObject({
      requestedImageGenerationModel: model,
      routedModel: "gpt-6-astra",
      tokenUsage: { total_tokens: 12 },
    });
    expect(JSON.stringify(result)).not.toContain("test-secret");
  },
);

it.each([{ output: [] }, { output: [{ id: "message-1", type: "message" }] }])(
  "uses streamed images omitted from terminal output",
  async ({ output }) => {
    const result = await readCodexImageResponse(
      stream(
        [
          { type: "response.output_item.done", item: image },
          { ...completed, response: { ...completed.response, output } },
        ],
        true,
        false,
      ),
    );
    expect(result.output).toEqual([...output, image]);
  },
);

it.each(["error", "response.failed", "response.incomplete"])(
  "retains %s after a completed image",
  async (type) => {
    const error = {
      code: "moderation_blocked",
      message: "refused",
      moderation_details: { categories: ["sexual"] },
    };
    const result = readCodexImageResponse(
      stream([completed, { type, error, response: { error } }]),
    );
    await expect(result).rejects.toMatchObject({
      code: "moderation_blocked",
      nonRetriable: true,
    });
    expect(isSexualImageRefusal(await result.catch((reason) => reason))).toBe(
      true,
    );
  },
);

it("retains image item failure and rejects incomplete streams", async () => {
  await expect(
    readCodexImageResponse(
      stream([
        {
          type: "response.output_item.done",
          item: {
            ...image,
            status: "failed",
            error: { message: "image failed" },
          },
        },
        completed,
      ]),
    ),
  ).rejects.toThrow("image failed");
  await expect(
    readCodexImageResponse(
      stream([{ type: "response.output_item.done", item: image }]),
    ),
  ).rejects.toThrow("끊겼습니다");
  await expect(readCodexImageResponse(new Response(null))).rejects.toThrow(
    "본문",
  );
  await expect(
    readCodexImageResponse(new Response("data: invalid\n\n")),
  ).rejects.toThrow();
});

it.each([401, 403, 429, 500])(
  "reports HTTP %s without retry or fallback",
  async (status) => {
    http.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "provider refused", code: "request_denied" },
        }),
        { status },
      ),
    );
    await expect(
      runCodexImageResponse(
        { dataRoot: directory },
        "gpt-image-2.5-flare",
        request,
      ),
    ).rejects.toMatchObject({ status, code: "request_denied" });
    expect(http).toHaveBeenCalledOnce();
  },
);

it("handles non-JSON HTTP errors and invalid credentials without exposing them", async () => {
  http.mockResolvedValue(
    new Response("secret proxy body", {
      status: 502,
      statusText: "Bad Gateway",
    }),
  );
  await expect(
    runCodexImageResponse(
      { dataRoot: directory },
      "gpt-image-2.5-flare",
      request,
    ),
  ).rejects.toThrow("Bad Gateway");
  http.mockClear();
  await writeFile(
    join(directory, "codex", "auth.json"),
    JSON.stringify({
      auth_mode: "apiKey",
      tokens: { access_token: "test-secret" },
    }),
  );
  await expect(
    runCodexImageResponse(
      { dataRoot: directory },
      "gpt-image-2.5-flare",
      request,
    ),
  ).rejects.toThrow("다시 로그인");
  expect(http).not.toHaveBeenCalled();
});

it.each([{ output: [] }, { output: [image, { ...image, id: "image-2" }] }])(
  "rejects missing or duplicate results",
  async ({ output }) => {
    http.mockResolvedValue(
      stream([{ ...completed, response: { ...completed.response, output } }]),
    );
    await expect(
      runCodexImageResponse(
        { dataRoot: directory },
        "gpt-image-2.5-flare",
        request,
      ),
    ).rejects.toThrow("한 장");
  },
);

it("does not send cancelled requests", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    runCodexImageResponse({ dataRoot: directory }, "gpt-image-2.5-flare", {
      ...request,
      signal: abort.signal,
    }),
  ).rejects.toThrow();
  expect(http).not.toHaveBeenCalled();
});

it.each([
  ["auto", "image-generation"],
  ["gpt-image-2.5-flare", "image-generation"],
  ["gpt-image-2.5-sunburst", "image-generation"],
  ["gpt-image-2.5-sunburst", "isolated"],
] as const)(
  "routes saved %s with capability %s through the production image session",
  async (model, capability) => {
    const account = vi.fn<CodexAppServerClient["readAccount"]>(async () => ({
      account: { type: "chatgpt", email: null, planType: "plus" },
      requiresOpenaiAuth: true,
    }));
    const nativeTurn = vi.fn(async () => ({
      text: "native",
      threadId: "thread",
      turnId: "turn",
      itemId: null,
    }));
    const dispose = vi.fn(async () => {});
    // App Server and HTTP are external model transport boundaries.
    const connection: Pick<
      CodexAppServerClient,
      "readAccount" | "listModels" | "runEphemeralTurn" | "dispose"
    > = {
      readAccount: account,
      listModels: async () => [
        {
          id: "gpt-6-astra",
          displayName: "GPT-6-Astra",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low"],
        },
      ],
      runEphemeralTurn: nativeTurn,
      dispose,
    };
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(
      connection as CodexAppServerClient,
    );
    http.mockResolvedValue(stream([completed]));
    const settings = resolveDefaultAppSettings({});
    settings.codex.imageGenerationModel = model;
    const session = await withApprovedImageRedactions([], () =>
      startCodexImageSession(
        { dataRoot: directory } as AppPaths,
        settings,
        directory,
        new AbortController().signal,
        capability,
      ),
    );
    await session.runEphemeralTurn(request);
    const native = model === "auto" || capability === "isolated";
    expect(nativeTurn).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(http).toHaveBeenCalledTimes(native ? 0 : 1);
    expect(account).toHaveBeenCalledTimes(native ? 1 : 2);
    await session.dispose();
    await expect(session.runEphemeralTurn(request)).rejects.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  },
);
