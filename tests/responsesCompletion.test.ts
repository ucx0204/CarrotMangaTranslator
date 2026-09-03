import { afterEach, describe, expect, it, vi } from "vitest";

const { requestResponsesText } =
  require("../src/main/runtime/transport/responses-completion.cjs") as {
    requestResponsesText: (
      server: { baseUrl: string },
      options: Record<string, unknown>,
      requestBody: Record<string, unknown>,
      requestSummary: Record<string, unknown>,
    ) => Promise<{ outputText: string; rawResponse: unknown }>;
  };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Responses API completion transport", () => {
  it("posts the request and returns completed streaming output", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responsesStream({
        type: "response.completed",
        response: { id: "resp_1", status: "completed", output: [] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const abortController = new AbortController();
    const requestBody = { model: "gpt-test", input: "Return JSON." };

    await expect(
      requestResponsesText(
        { baseUrl: "https://codex.invalid/v1" },
        {
          modelProvider: "openai-codex",
          abortSignal: abortController.signal,
        },
        requestBody,
        { operation: "translation" },
      ),
    ).resolves.toMatchObject({
      outputText: '{"items":[]}',
      rawResponse: {
        id: "resp_1",
        status: "completed",
        streamEventCount: 2,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://codex.invalid/v1/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      }),
    );
  });

  it("preserves HTTP failure details for callers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"error":{"message":"invalid request"}}', {
          status: 400,
          statusText: "Bad Request",
        }),
      ),
    );

    await expect(
      requestResponsesText(
        { baseUrl: "https://provider.invalid/v1" },
        {
          modelProvider: "openai-api",
          apiBaseUrl: "https://provider.invalid/v1",
          apiModel: "vision-model",
          apiKey: "secret-key",
        },
        { model: "vision-model" },
        { operation: "review" },
      ),
    ).rejects.toMatchObject({
      status: 400,
      statusText: "Bad Request",
      nonRetriable: true,
      failureCategory: "model-request",
      requestSummary: { operation: "review" },
    });
  });

  it("wraps network failures with the request summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed")),
    );

    await expect(
      requestResponsesText(
        { baseUrl: "https://codex.invalid/v1" },
        { modelProvider: "openai-codex" },
        { model: "gpt-test" },
        { operation: "analysis" },
      ),
    ).rejects.toMatchObject({
      requestSummary: { operation: "analysis" },
      cause: expect.objectContaining({ message: "socket closed" }),
    });
  });
});

function responsesStream(terminalEvent: Record<string, unknown>): Response {
  return new Response(
    [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"{\\"items\\":[]}"}',
      "",
      `event: ${String(terminalEvent.type)}`,
      `data: ${JSON.stringify(terminalEvent)}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200 },
  );
}
