import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import type { TranslationOptions } from "../src/main/appSettings";
import {
  startCodexAppServerEndpoint,
  stopCodexAppServerEndpoint,
  type CodexAppServerEndpointClient,
  type CodexAppServerEndpointRuntime,
} from "../src/main/codexAppServerEndpoint";

type ResponsesParser = {
  parseResponsesSseText: (rawText: string) => {
    outputText: string;
    rawResponse: unknown;
    eventCount: number;
  };
};

const responsesParser =
  require("../src/main/runtime/transport/response-text.cjs") as ResponsesParser;
const temporaryDirectories: string[] = [];
const originalLogPath = process.env.MANGA_TRANSLATOR_LOG_PATH;

beforeEach(() => {
  process.env.MANGA_TRANSLATOR_LOG_PATH = join(
    createTemporaryRoot(),
    "app.log",
  );
});

afterEach(() => {
  if (originalLogPath === undefined) {
    delete process.env.MANGA_TRANSLATOR_LOG_PATH;
  } else {
    process.env.MANGA_TRANSLATOR_LOG_PATH = originalLogPath;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex App Server Responses compatibility endpoint", () => {
  it("maps existing Responses API text, image, schema, and SSE contracts", async () => {
    const root = createTemporaryRoot();
    const paths = createAppPaths(root);
    const runEphemeralTurn = vi.fn(async () => ({
      text: '{"translated":"안녕"}',
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
    }));
    const dispose = vi.fn(async () => undefined);
    const client = {
      version: "0.150.1",
      process: {} as ChildProcessWithoutNullStreams,
      readAccount: vi.fn(async () => ({
        account: {
          type: "chatgpt" as const,
          email: "reader@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      })),
      listModels: vi.fn(async () => [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          hidden: false,
          supportedReasoningEfforts: ["high"],
          defaultReasoningEffort: "high",
          isDefault: true,
        },
      ]),
      runEphemeralTurn,
      dispose,
    } satisfies CodexAppServerEndpointClient;
    const endpoint = await startCodexAppServerEndpoint(
      createTranslationOptions(),
      createEndpointRuntime(paths, client),
    );

    try {
      expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      const modelsResponse = await fetch(`${endpoint.baseUrl}/models`);
      await expect(modelsResponse.json()).resolves.toEqual({
        object: "list",
        data: [{ id: "gpt-test", object: "model", owned_by: "openai" }],
      });

      const response = await fetch(`${endpoint.baseUrl}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          instructions: "Return structured translation JSON.",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "translate this panel" },
                {
                  type: "input_image",
                  image_url: "data:image/png;base64,AA==",
                  detail: "high",
                },
              ],
            },
          ],
          reasoning: { effort: "high" },
          text: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: { translated: { type: "string" } },
              },
            },
          },
          stream: true,
          store: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const parsed = responsesParser.parseResponsesSseText(
        await response.text(),
      );
      expect(parsed.outputText).toBe('{"translated":"안녕"}');
      expect(parsed.eventCount).toBe(2);
      expect(runEphemeralTurn).toHaveBeenCalledWith({
        model: "gpt-test",
        effort: "high",
        instructions: "Return structured translation JSON.",
        input: [
          { type: "text", text: "translate this panel" },
          {
            type: "image",
            url: "data:image/png;base64,AA==",
            detail: "high",
          },
        ],
        outputSchema: {
          type: "object",
          properties: { translated: { type: "string" } },
        },
        cwd: paths.codexWorkspaceDir,
        signal: expect.any(AbortSignal),
      });

      const invalidImageResponse = await fetch(
        `${endpoint.baseUrl}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-test",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_image",
                    image_url: "https://untrusted.example/panel.png",
                  },
                ],
              },
            ],
          }),
        },
      );
      expect(invalidImageResponse.status).toBe(400);
      expect(runEphemeralTurn).toHaveBeenCalledOnce();

      const upstreamError = {
        type: "invalid_request_error",
        code: "invalid_json_schema",
        message: "The response schema is invalid.",
        param: "text.format.schema",
      };
      runEphemeralTurn.mockRejectedValueOnce(
        Object.assign(new Error(upstreamError.message), {
          httpStatus: 400,
          upstreamError,
        }),
      );
      const upstreamFailureResponse = await fetch(
        `${endpoint.baseUrl}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-test",
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: "translate" }],
              },
            ],
          }),
        },
      );
      expect(upstreamFailureResponse.status).toBe(400);
      await expect(upstreamFailureResponse.json()).resolves.toEqual({
        error: upstreamError,
      });
      expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
    } finally {
      await stopCodexAppServerEndpoint(endpoint);
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails before listening when the app-specific ChatGPT account is signed out", async () => {
    const root = createTemporaryRoot();
    const dispose = vi.fn(async () => undefined);
    const client = {
      version: "0.150.1",
      process: {} as ChildProcessWithoutNullStreams,
      readAccount: vi.fn(async () => ({
        account: null,
        requiresOpenaiAuth: true,
      })),
      listModels: vi.fn(async () => []),
      runEphemeralTurn: vi.fn(async () => {
        throw new Error("Unexpected turn");
      }),
      dispose,
    } satisfies CodexAppServerEndpointClient;

    await expect(
      startCodexAppServerEndpoint(
        createTranslationOptions(),
        createEndpointRuntime(createAppPaths(root), client),
      ),
    ).rejects.toThrow("ChatGPT로 로그인");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps the main event loop responsive during a five-megabyte image request", async () => {
    const root = createTemporaryRoot();
    const paths = createAppPaths(root);
    const turnStarted = createDeferred<void>();
    const releaseTurn = createDeferred<void>();
    const runEphemeralTurn = vi.fn(async () => {
      turnStarted.resolve(undefined);
      await releaseTurn.promise;
      return {
        text: '{"translated":"완료"}',
        threadId: "thread-large",
        turnId: "turn-large",
        itemId: "message-large",
      };
    });
    const client = {
      version: "0.150.1",
      process: {} as ChildProcessWithoutNullStreams,
      readAccount: vi.fn(async () => ({
        account: {
          type: "chatgpt" as const,
          email: "reader@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      })),
      listModels: vi.fn(async () => []),
      runEphemeralTurn,
      dispose: vi.fn(async () => undefined),
    } satisfies CodexAppServerEndpointClient;
    const endpoint = await startCodexAppServerEndpoint(
      createTranslationOptions(),
      createEndpointRuntime(paths, client),
    );

    try {
      const heartbeat = new Promise<void>((resolve) => setTimeout(resolve, 0));
      const responsePromise = fetch(`${endpoint.baseUrl}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`,
                },
              ],
            },
          ],
        }),
      });
      const modelsResponse = await fetch(`${endpoint.baseUrl}/models`);
      await heartbeat;
      expect(modelsResponse.status).toBe(200);
      await turnStarted.promise;
      releaseTurn.resolve(undefined);
      expect((await responsePromise).status).toBe(200);
      expect(runEphemeralTurn).toHaveBeenCalledOnce();
    } finally {
      releaseTurn.resolve(undefined);
      await stopCodexAppServerEndpoint(endpoint);
    }
  }, 15_000);
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createEndpointRuntime(
  paths: AppPaths,
  client: CodexAppServerEndpointClient,
): CodexAppServerEndpointRuntime {
  return {
    getPaths: () => paths,
    appVersion: () => "1.20.2-test",
    startClient: vi.fn(async () => client),
  };
}

function createTranslationOptions(): TranslationOptions {
  return {
    label: "Codex test",
    modelProvider: "openai-codex",
    codexModel: "gpt-test",
    codexReasoningEffort: "high",
  } as TranslationOptions;
}

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mgt-codex-endpoint-test-"));
  temporaryDirectories.push(root);
  return root;
}

function createAppPaths(root: string): AppPaths {
  return {
    isPackaged: true,
    repoRoot: root,
    executableDir: root,
    resourcesDir: root,
    dataRoot: root,
    settingsPath: join(root, "settings.json"),
    libraryDir: join(root, "library"),
    fontsDir: join(root, "fonts"),
    logsDir: join(root, "logs"),
    logFile: join(root, "logs", "app.log"),
    runtimeDir: join(root, "runtime"),
    toolsDir: join(root, "tools"),
    ocrRuntimeDir: join(root, "ocr-runtime"),
    llamaRuntimeDir: join(root, "llama"),
    llamaServerPath: join(root, "llama", "llama-server"),
    codexHomeDir: join(root, "codex-home"),
    codexWorkspaceDir: join(root, "workspace"),
  };
}
