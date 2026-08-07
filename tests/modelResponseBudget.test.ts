import { describe, expect, it, vi } from "vitest";

const { readCodexResponsesStream, readResponseText } =
  require("../src/main/runtime/transport/model-response-readers.cjs") as {
    readCodexResponsesStream: (
      response: Response,
      summary: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    readResponseText: (
      response: Response,
      summary: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<string>;
  };
const { runWithApiKeyRetry } =
  require("../src/main/runtime/transport/api-key-retry.cjs") as {
    runWithApiKeyRetry: <T>(
      options: Record<string, unknown>,
      attempt: (key: string | undefined) => Promise<T>,
    ) => Promise<T>;
  };
const { createRequestDeadlineError } =
  require("../src/main/runtime/transport/http-deadline.cjs") as {
    createRequestDeadlineError: (label: string, timeoutMs: number) => Error;
  };
const { MAX_MODEL_HTTP_RESPONSE_BYTES } =
  require("../src/main/runtime/transport/network-budgets.cjs") as {
    MAX_MODEL_HTTP_RESPONSE_BYTES: number;
  };

const retryOptions = {
  modelProvider: "openai-api",
  apiKey: "key-one\nkey-two",
  apiKeyMaxAttempts: 2,
  apiRetryDelaySeconds: 0,
};

describe("model response budgets", () => {
  it("rejects an oversized successful response before body pull and key rotation", async () => {
    let pulls = 0;
    let attempts = 0;
    await expect(
      runWithApiKeyRetry(retryOptions, async () => {
        attempts += 1;
        const response = oversizedDeclaredResponse(200, () => {
          pulls += 1;
        });
        return await readResponseText(response, {}, retryOptions);
      }),
    ).rejects.toMatchObject({
      code: "HTTP_RESPONSE_TOO_LARGE",
      responseBudgetExceeded: true,
      nonRetriable: true,
    });
    expect(attempts).toBe(1);
    expect(pulls).toBe(0);
  });

  it("bounds oversized HTTP error bodies too", async () => {
    await expect(
      readResponseText(oversizedDeclaredResponse(500), {}, retryOptions),
    ).rejects.toMatchObject({ code: "HTTP_RESPONSE_TOO_LARGE" });
  });

  it("rejects oversized Codex SSE before semantic parsing", async () => {
    await expect(
      readCodexResponsesStream(
        oversizedDeclaredResponse(200),
        {},
        {
          modelProvider: "openai-codex",
        },
      ),
    ).rejects.toMatchObject({ code: "HTTP_RESPONSE_TOO_LARGE" });
  });

  it("does not rotate API keys for request deadline errors", async () => {
    const attempt = vi.fn(async () => {
      throw createRequestDeadlineError("model", 10);
    });
    await expect(
      runWithApiKeyRetry(retryOptions, attempt),
    ).rejects.toMatchObject({
      code: "HTTP_REQUEST_DEADLINE_EXCEEDED",
      requestDeadlineExceeded: true,
      nonRetriable: true,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("keeps normal model response text behavior", async () => {
    await expect(
      readResponseText(
        new Response('{"choices":[]}'),
        {},
        { modelProvider: "openai-api" },
      ),
    ).resolves.toBe('{"choices":[]}');
  });
});

function oversizedDeclaredResponse(
  status: number,
  onPull: () => void = () => undefined,
): Response {
  const body = new ReadableStream<Uint8Array>({ pull: onPull });
  return new Response(body, {
    status,
    headers: {
      "content-length": String(MAX_MODEL_HTTP_RESPONSE_BYTES + 1),
    },
  });
}
