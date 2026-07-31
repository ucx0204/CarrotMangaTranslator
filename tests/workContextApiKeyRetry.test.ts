import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import type { ModelEndpointHandle } from "../src/main/pipeline/types";
import { requestWorkContextAnalysisText } from "../src/main/workContextModelRequest";
import { createWorkContextRequestRuntime } from "../src/main/workContextRequestRuntime";
import { loadRuntimeModuleFromDirectory } from "../src/main/runtimeModuleLoader";

const runtimeDirectory = resolve(process.cwd(), "src/main/runtime");
const runtime = createWorkContextRequestRuntime((moduleId) =>
  loadRuntimeModuleFromDirectory(runtimeDirectory, moduleId),
);

const apiEnvNames = [
  "MANGA_TRANSLATOR_API_KEY",
  "MANGA_TRANSLATOR_API_KEY_MAX_ATTEMPTS",
  "MANGA_TRANSLATOR_API_RETRY_DELAY_SECONDS",
] as const;
const originalApiEnv = new Map(
  apiEnvNames.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  for (const name of apiEnvNames) {
    delete process.env[name];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of apiEnvNames) {
    const value = originalApiEnv.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("work context API key retries", () => {
  it("rotates keys with the shared policy", async () => {
    const authorizationHeaders: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        authorizationHeaders.push(headers.Authorization);
        if (authorizationHeaders.length < 3) {
          return new Response('{"error":"retry"}', { status: 429 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "작품 컨텍스트 완료" } }],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await requestWorkContextAnalysisText({
      endpoint: {
        baseUrl: "https://provider.invalid/v1",
        child: null,
        provider: "openai-api",
        startedByScript: false,
      } satisfies ModelEndpointHandle,
      options: {
        modelProvider: "openai-api",
        apiBaseUrl: "https://provider.invalid/v1",
        apiModel: "vision-model",
        apiKey: "key-one\nkey-two",
        apiKeyMaxAttempts: 2,
        apiRetryDelaySeconds: 0,
      } as TranslationOptions,
      systemPrompt: "system",
      userPrompt: "user",
      maxOutputTokens: 256,
      runtime,
    });

    expect(result).toBe("작품 컨텍스트 완료");
    expect(authorizationHeaders).toEqual([
      "Bearer key-one",
      "Bearer key-two",
      "Bearer key-one",
    ]);
  });

  it("rejects nonempty chat output stopped by max_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "length",
                message: { content: '{"glossary":[' },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      requestWorkContextAnalysisText({
        endpoint: {
          baseUrl: "https://provider.invalid/v1",
          child: null,
          provider: "openai-api",
          startedByScript: false,
        } satisfies ModelEndpointHandle,
        options: {
          modelProvider: "openai-api",
          apiBaseUrl: "https://provider.invalid/v1",
          apiModel: "vision-model",
          apiKey: "key-one",
          apiKeyMaxAttempts: 0,
          apiRetryDelaySeconds: 0,
        } as TranslationOptions,
        systemPrompt: "system",
        userPrompt: "user",
        maxOutputTokens: 256,
        runtime,
      }),
    ).rejects.toMatchObject({
      failureCategory: "empty-model-response",
      outputTruncated: true,
    });
  });

  it("rejects nonempty Codex Responses output stopped by max_output_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            [
              "event: response.output_text.delta",
              'data: {"type":"response.output_text.delta","delta":"{\\"glossary\\":["}',
              "",
              "event: response.incomplete",
              'data: {"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
            { status: 200 },
          ),
        ),
    );

    await expect(
      requestWorkContextAnalysisText({
        endpoint: {
          baseUrl: "https://codex.invalid/v1",
          child: null,
          startedByScript: false,
        } satisfies ModelEndpointHandle,
        options: {
          modelProvider: "openai-codex",
          codexModel: "gpt-5.6-sol",
          codexReasoningEffort: "low",
        } as TranslationOptions,
        systemPrompt: "system",
        userPrompt: "user",
        maxOutputTokens: 256,
        runtime,
      }),
    ).rejects.toMatchObject({
      failureCategory: "empty-model-response",
      outputTruncated: true,
    });
  });
});
