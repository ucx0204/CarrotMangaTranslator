import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import type { ModelEndpointHandle } from "../src/main/pipeline/types";
import {
  MAX_MODEL_HTTP_RESPONSE_BYTES,
  MODEL_HTTP_REQUEST_DEADLINE_MS,
} from "../src/main/networkBudgets";
import { loadRuntimeModuleFromDirectory } from "../src/main/runtimeModuleLoader";
import { requestWorkContextAnalysisText } from "../src/main/workContextModelRequest";
import { createWorkContextRequestRuntime } from "../src/main/workContextRequestRuntime";

const runtimeDirectory = resolve(process.cwd(), "src/main/runtime");
const runtime = createWorkContextRequestRuntime((moduleId) =>
  loadRuntimeModuleFromDirectory(runtimeDirectory, moduleId),
);
const endpoint = {
  baseUrl: "https://provider.invalid/v1",
  child: null,
  provider: "openai-api",
  startedByScript: false,
} satisfies ModelEndpointHandle;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("work context response budgets", () => {
  it("rejects oversized chat JSON before parsing or API-key rotation", async () => {
    let pulls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      oversizedResponse(() => {
        pulls += 1;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestWorkContextAnalysisText(
        requestArgs({
          modelProvider: "openai-api",
          apiKey: "key-one\nkey-two",
          apiKeyMaxAttempts: 2,
          apiRetryDelaySeconds: 0,
        } as TranslationOptions),
      ),
    ).rejects.toMatchObject({
      code: "HTTP_RESPONSE_TOO_LARGE",
      responseBudgetExceeded: true,
      nonRetriable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("rejects oversized Codex SSE before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(oversizedResponse()),
    );
    await expect(
      requestWorkContextAnalysisText(
        requestArgs({
          modelProvider: "openai-codex",
          codexModel: "gpt-5.6-sol",
          codexReasoningEffort: "low",
        } as TranslationOptions),
      ),
    ).rejects.toMatchObject({ code: "HTTP_RESPONSE_TOO_LARGE" });
  });

  it("applies the absolute deadline through a body that never closes", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 200 })),
    );

    const pending = requestWorkContextAnalysisText(
      requestArgs({
        modelProvider: "openai-api",
        apiKey: "key-one\nkey-two",
        apiKeyMaxAttempts: 2,
        apiRetryDelaySeconds: 0,
      } as TranslationOptions),
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: "HTTP_REQUEST_DEADLINE_EXCEEDED",
      requestDeadlineExceeded: true,
      nonRetriable: true,
    });
    await vi.advanceTimersByTimeAsync(MODEL_HTTP_REQUEST_DEADLINE_MS);
    await rejection;
    expect(cancelled).toBe(true);
  });

  it("keeps normal chat extraction unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "정상 결과" } }],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      requestWorkContextAnalysisText(
        requestArgs({
          modelProvider: "openai-api",
          apiKey: "key-one",
          apiKeyMaxAttempts: 1,
          apiRetryDelaySeconds: 0,
        } as TranslationOptions),
      ),
    ).resolves.toBe("정상 결과");
  });
});

function requestArgs(options: TranslationOptions) {
  return {
    endpoint,
    options: {
      ...options,
      apiBaseUrl: options.apiBaseUrl ?? endpoint.baseUrl,
      apiModel: options.apiModel ?? "vision-model",
    } as TranslationOptions,
    systemPrompt: "system",
    userPrompt: "user",
    maxOutputTokens: 256,
    runtime,
  };
}

function oversizedResponse(onPull: () => void = () => undefined): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        onPull();
      },
    }),
    {
      status: 200,
      headers: {
        "content-length": String(MAX_MODEL_HTTP_RESPONSE_BYTES + 1),
      },
    },
  );
}
