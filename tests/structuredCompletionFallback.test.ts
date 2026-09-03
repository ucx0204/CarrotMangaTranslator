import { afterEach, describe, expect, it, vi } from "vitest";

const { buildJsonObjectFallback, requestStructuredCompletion } =
  require("../src/main/runtime/transport/structured-completion.cjs") as {
    buildJsonObjectFallback: (
      options: Record<string, unknown>,
      requestBody: Record<string, unknown>,
      error: unknown,
    ) => Record<string, unknown> | null;
    requestStructuredCompletion: (
      server: { baseUrl: string },
      options: Record<string, unknown>,
      requestBody: Record<string, unknown>,
      requestSummary: Record<string, unknown>,
      requestStartedAt: number,
    ) => Promise<{
      response: { outputText: string };
      forbiddenTokenBias: unknown;
    }>;
  };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible structured output fallback", () => {
  it("retries a rejected JSON Schema once in JSON object mode", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async (_input, init) => {
          bodies.push(readBody(init));
          return jsonResponse(
            {
              error: {
                code: 400,
                message: "Request contains an invalid argument.",
                status: "INVALID_ARGUMENT",
              },
            },
            400,
          );
        })
        .mockImplementationOnce(async (_input, init) => {
          bodies.push(readBody(init));
          return jsonResponse({
            choices: [{ message: { content: '{"items":[]}' } }],
          });
        }),
    );
    const requestSummary: Record<string, unknown> = {};

    const result = await requestStructuredCompletion(
      {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      },
      {
        modelProvider: "openai-api",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiModel: "gemini-3.5-flash-lite",
        apiKey: "test-key",
        apiKeyMaxAttempts: 1,
      },
      schemaRequestBody(),
      requestSummary,
      Date.now(),
    );

    expect(result.response.outputText).toBe('{"items":[]}');
    expect(bodies).toHaveLength(2);
    expect(readResponseFormat(bodies[0])).toMatchObject({
      type: "json_schema",
    });
    expect(readResponseFormat(bodies[1])).toEqual({ type: "json_object" });
    expect(requestSummary.structuredOutputFallback).toBe("json_object");
  });

  it("does not hide credential failures behind a format retry", () => {
    expect(
      buildJsonObjectFallback(
        {
          modelProvider: "openai-api",
          apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        },
        schemaRequestBody(),
        {
          status: 400,
          apiKeyRetryable: true,
          rawTextPreview: "API_KEY_INVALID",
        },
      ),
    ).toBeNull();
  });

  it("does not downgrade unrelated custom-provider validation errors", () => {
    expect(
      buildJsonObjectFallback(
        {
          modelProvider: "openai-api",
          apiBaseUrl: "https://example.invalid/v1",
        },
        schemaRequestBody(),
        {
          status: 400,
          rawTextPreview: "Invalid image payload",
        },
      ),
    ).toBeNull();
  });
});

function schemaRequestBody(): Record<string, unknown> {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "Return JSON." }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test",
        strict: true,
        schema: {
          type: "object",
          properties: { items: { type: "array" } },
          required: ["items"],
          additionalProperties: false,
        },
      },
    },
  };
}

function readBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function readResponseFormat(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return body.response_format as Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    headers: { "Content-Type": "application/json" },
  });
}
