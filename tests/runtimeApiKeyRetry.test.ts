import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempDir,
  requestTranslation,
} from "./helpers/runtimeModelContracts";

type RetryError = Error & {
  apiKeyAttemptCount?: number;
  apiKeyCount?: number;
  apiKeyRetriesExhausted?: boolean;
  failureCategory?: string;
  modelTransportError?: boolean;
  nonRetriable?: boolean;
  status?: number;
};

const { runWithApiKeyRetry } =
  require("../src/main/runtime/transport/api-key-retry.cjs") as {
    runWithApiKeyRetry: <TResult>(
      options: Record<string, unknown>,
      attempt: (apiKey: string | undefined) => Promise<TResult>,
    ) => Promise<TResult>;
  };
const {
  createEmptyOutputError,
  createHttpFailureError,
  createModelTransportError,
  isRetryableApiKeyHttpStatus,
  truncateSensitiveText,
} = require("../src/main/runtime/transport/model-http-errors.cjs") as {
  createEmptyOutputError: (
    parsed: unknown,
    rawText: string,
    requestSummary: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => RetryError & { rawResponse?: unknown; rawTextPreview?: string };
  createHttpFailureError: (
    options: Record<string, unknown>,
    requestSummary: Record<string, unknown>,
    response: Response,
    rawText: string,
  ) => RetryError;
  createModelTransportError: (
    message: string,
    detail: Record<string, unknown>,
    cause: unknown,
  ) => RetryError;
  isRetryableApiKeyHttpStatus: (status: number) => boolean;
  truncateSensitiveText: (
    value: unknown,
    options: Record<string, unknown>,
    maxLength: number,
  ) => string;
};
const { testModelReply } =
  require("../src/main/runtime/transport/model-probe.cjs") as {
    testModelReply: (
      server: { baseUrl: string },
      options: Record<string, unknown>,
    ) => Promise<{ outputText: string }>;
  };
const { buildChatRequestHeaders } =
  require("../src/main/runtime/simple-page-request-builders.cjs") as {
    buildChatRequestHeaders: (
      options: Record<string, unknown>,
      apiKeyOverride?: string,
    ) => Record<string, string>;
  };

const API_ENV_NAMES = [
  "MANGA_TRANSLATOR_API_KEY",
  "MANGA_TRANSLATOR_API_KEY_MAX_ATTEMPTS",
  "MANGA_TRANSLATOR_API_RETRY_DELAY_SECONDS",
  "OPENAI_API_KEY",
] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of API_ENV_NAMES) {
    originalEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of API_ENV_NAMES) {
    const value = originalEnv.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  originalEnv.clear();
});

describe("runtime API key retry policy", () => {
  it("obtains a fresh dynamic token for Vertex requests and refreshes after auth failure", async () => {
    const tokenProvider = vi
      .fn()
      .mockResolvedValueOnce("service-token-1")
      .mockResolvedValueOnce("service-token-2");
    const attemptedKeys: Array<string | undefined> = [];

    const result = await runWithApiKeyRetry(
      {
        modelProvider: "openai-api",
        apiAccessTokenProvider: tokenProvider,
        apiKey: "stale-manual-token",
        apiKeyMaxAttempts: 2,
        apiRetryDelaySeconds: 0,
      },
      async (apiKey) => {
        attemptedKeys.push(apiKey);
        if (attemptedKeys.length === 1) {
          throw Object.assign(new Error("expired"), { status: 401 });
        }
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(attemptedKeys).toEqual(["service-token-1", "service-token-2"]);
    expect(tokenProvider).toHaveBeenNthCalledWith(1, {
      forceRefresh: false,
    });
    expect(tokenProvider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  });

  it("cycles key 1 through key N once per round", async () => {
    const attemptedKeys: Array<string | undefined> = [];

    const result = await runWithApiKeyRetry(
      {
        modelProvider: "openai-api",
        apiKey: "key-one\nkey-two",
        apiKeyMaxAttempts: 2,
        apiRetryDelaySeconds: 0,
      },
      async (apiKey) => {
        attemptedKeys.push(apiKey);
        if (attemptedKeys.length < 4) {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(attemptedKeys).toEqual(["key-one", "key-two", "key-one", "key-two"]);
  });

  it("retries only the approved HTTP status set", () => {
    for (const status of [401, 402, 403, 408, 409, 425, 429, 500, 503, 599]) {
      expect(isRetryableApiKeyHttpStatus(status), String(status)).toBe(true);
    }
    for (const status of [400, 404, 422, 499, 600]) {
      expect(isRetryableApiKeyHttpStatus(status), String(status)).toBe(false);
    }
  });

  it("stops immediately when Codex reports a hard usage limit", () => {
    const rawText = JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_at: 1_785_903_018,
        resets_in_seconds: 558_651,
      },
    });
    const error = createHttpFailureError(
      { modelProvider: "openai-codex" },
      {},
      new Response(rawText, {
        status: 429,
        statusText: "Too Many Requests",
      }),
      rawText,
    );

    expect(error).toMatchObject({
      failureCategory: "model-request",
      nonRetriable: true,
      status: 429,
      usageLimitReached: true,
      usageLimitResetAt: 1_785_903_018,
      usageLimitResetInSeconds: 558_651,
    });
    expect(error.message).toContain(
      "OpenAI Codex 요청 실패: 사용 한도에 도달했습니다.",
    );
    expect(error.message).toContain("약 6일 11시간");
    expect(error.message).toContain("다른 모델 제공자를 선택하세요.");
  });

  it("keeps an ordinary 429 retryable", () => {
    const rawText = '{"error":{"type":"server_busy"}}';
    const error = createHttpFailureError(
      { modelProvider: "openai-codex" },
      {},
      new Response(rawText, {
        status: 429,
        statusText: "Too Many Requests",
      }),
      rawText,
    );

    expect(error.message).toBe("OpenAI Codex request failed (429).");
    expect(error.nonRetriable).toBeUndefined();
  });

  it("leaves the API-key provider's 429 policy unchanged", () => {
    const rawText = '{"error":{"type":"usage_limit_reached"}}';
    const error = createHttpFailureError(
      { modelProvider: "openai-api" },
      {},
      new Response(rawText, { status: 429 }),
      rawText,
    );

    expect(error.nonRetriable).toBeUndefined();
    expect(error).not.toHaveProperty("usageLimitReached");
  });

  it("does not infer a Codex usage limit from malformed or unstructured text", () => {
    for (const rawText of [
      "usage_limit_reached",
      '{"error":{"message":"usage_limit_reached"}}',
      '{"error":',
    ]) {
      const error = createHttpFailureError(
        { modelProvider: "openai-codex" },
        {},
        new Response(rawText, { status: 429 }),
        rawText,
      );

      expect(error.nonRetriable).toBeUndefined();
      expect(error).not.toHaveProperty("usageLimitReached");
    }
  });

  it("stops immediately for an independent 4xx response", async () => {
    const error = Object.assign(new Error("bad request"), {
      failureCategory: "model-request",
      nonRetriable: true,
      status: 400,
    });
    const attempt = vi.fn(async () => {
      throw error;
    });

    await expect(
      runWithApiKeyRetry(
        {
          modelProvider: "openai-api",
          apiKey: "key-one\nkey-two",
          apiKeyMaxAttempts: 3,
          apiRetryDelaySeconds: 0,
        },
        attempt,
      ),
    ).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("rotates after Google's 400 API_KEY_INVALID credential response", async () => {
    const attemptedKeys: Array<string | undefined> = [];
    const result = await runWithApiKeyRetry(
      {
        modelProvider: "openai-api",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: "invalid-key\nvalid-key",
        apiKeyMaxAttempts: 1,
        apiRetryDelaySeconds: 0,
      },
      async (apiKey) => {
        attemptedKeys.push(apiKey);
        if (apiKey === "invalid-key") {
          const rawText = JSON.stringify({
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: "Please pass a valid API key",
            },
          });
          throw createHttpFailureError(
            { modelProvider: "openai-api", apiKey: "invalid-key\nvalid-key" },
            {},
            new Response(rawText, { status: 400, statusText: "Bad Request" }),
            rawText,
          );
        }
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(attemptedKeys).toEqual(["invalid-key", "valid-key"]);
  });

  it("marks an exhausted pool non-retriable without replacing its category", async () => {
    const attempt = vi.fn(async () => {
      throw Object.assign(new Error("upstream unavailable"), {
        failureCategory: "provider-overload",
        status: 503,
      });
    });

    const rejected = await runWithApiKeyRetry(
      {
        modelProvider: "openai-api",
        apiKey: "key-one\nkey-two",
        apiKeyMaxAttempts: 2,
        apiRetryDelaySeconds: 0,
      },
      attempt,
    ).catch((error: RetryError) => error);

    expect(attempt).toHaveBeenCalledTimes(4);
    expect(rejected).toMatchObject({
      apiKeyAttemptCount: 4,
      apiKeyCount: 2,
      apiKeyRetriesExhausted: true,
      failureCategory: "provider-overload",
      nonRetriable: true,
      status: 503,
    });
  });

  it("rotates after transport failures", async () => {
    const attemptedKeys: Array<string | undefined> = [];
    const result = await runWithApiKeyRetry(
      {
        modelProvider: "openai-api",
        apiKey: "key-one\nkey-two",
        apiKeyMaxAttempts: 1,
        apiRetryDelaySeconds: 0,
      },
      async (apiKey) => {
        attemptedKeys.push(apiKey);
        if (apiKey === "key-one") {
          throw createModelTransportError(
            "transport failed",
            {},
            new TypeError("fetch failed"),
          );
        }
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(attemptedKeys).toEqual(["key-one", "key-two"]);
  });

  it("cancels a pending retry delay when the caller aborts", async () => {
    const controller = new AbortController();
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const request = runWithApiKeyRetry(
      {
        modelProvider: "openai-api",
        apiKey: "key-one\nkey-two",
        apiKeyMaxAttempts: 2,
        apiRetryDelaySeconds: 60,
        abortSignal: controller.signal,
      },
      async () => {
        releaseFirstAttempt?.();
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
    );

    await firstAttempt;
    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("redacts every configured key line independently", () => {
    const preview = truncateSensitiveText(
      "first=key-one second=key-two",
      { apiKey: " key-one \r\n\r\n key-two " },
      4000,
    );

    expect(preview).toBe("first=[redacted-api-key] second=[redacted-api-key]");
    expect(preview).not.toContain("key-one");
    expect(preview).not.toContain("key-two");
  });

  it("does not let custom headers override the rotating key", () => {
    expect(() =>
      buildChatRequestHeaders(
        {
          modelProvider: "openai-api",
          apiCustomHeadersJson:
            '{"Authorization":"Bearer fixed-key","X-Test":"ok"}',
        },
        "rotating-key",
      ),
    ).toThrow("Authorization");
  });

  it("redacts key lines from structured error diagnostics", () => {
    const error = createEmptyOutputError(
      { echoed: ["key-one", { authorization: "Bearer key-two" }] },
      "key-one and key-two",
      {},
      { apiKey: "key-one\nkey-two" },
    );
    const diagnostics = JSON.stringify({
      rawResponse: error.rawResponse,
      rawTextPreview: error.rawTextPreview,
    });

    expect(diagnostics).not.toContain("key-one");
    expect(diagnostics).not.toContain("key-two");
    expect(diagnostics).toContain("[redacted-api-key]");
  });

  it("uses the same rotation policy for the model probe", async () => {
    const authorizationHeaders: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        authorizationHeaders.push(headers.Authorization);
        requestBodies.push(JSON.parse(String(init?.body)));
        if (authorizationHeaders.length === 1) {
          return new Response('{"error":"bad key"}', { status: 401 });
        }
        if (authorizationHeaders.length === 2) {
          return new Response('{"error":"busy"}', { status: 503 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "model test ok" } }],
          }),
          { status: 200 },
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await testModelReply(
      { baseUrl: "https://provider.invalid/v1" },
      {
        modelProvider: "openai-api",
        apiBaseUrl: "https://provider.invalid/v1",
        apiModel: "vision-model",
        apiKey: "key-one\nkey-two",
        apiKeyMaxAttempts: 2,
        apiRetryDelaySeconds: 0,
      },
    );

    expect(result.outputText).toBe("model test ok");
    expect(authorizationHeaders).toEqual([
      "Bearer key-one",
      "Bearer key-two",
      "Bearer key-one",
    ]);
    expect(requestBodies[0]).toMatchObject({
      messages: [
        expect.any(Object),
        {
          content: [
            {
              type: "image_url",
              image_url: {
                url: expect.stringMatching(
                  /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/,
                ),
              },
            },
            expect.any(Object),
          ],
        },
      ],
    });
  });

  it("uses the same rotation policy for page translation", async () => {
    const outputDir = createTempDir("api-key-translation-");
    const imagePath = join(outputDir, "page.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const authorizationHeaders: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        authorizationHeaders.push(headers.Authorization);
        if (authorizationHeaders.length === 1) {
          return new Response('{"error":"busy"}', { status: 503 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"items":[]}' } }],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await requestTranslation(
      { baseUrl: "https://provider.invalid/v1" },
      {
        modelProvider: "openai-api",
        apiBaseUrl: "https://provider.invalid/v1",
        apiModel: "vision-model",
        apiKey: "key-one\nkey-two",
        apiKeyMaxAttempts: 1,
        apiRetryDelaySeconds: 0,
        imagePath,
        outputDir,
        imageWidth: 100,
        imageHeight: 100,
        maxTokens: 256,
        ocrBboxHints: [
          {
            id: 1,
            label: "text",
            x1: 10,
            y1: 20,
            x2: 80,
            y2: 90,
            ocrText: "日本語",
          },
        ],
      },
    );

    expect(result.outputText).toBe('{"items":[]}');
    expect(authorizationHeaders).toEqual(["Bearer key-one", "Bearer key-two"]);
  });
});
