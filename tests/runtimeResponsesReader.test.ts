import { describe, expect, it } from "vitest";

const { readCodexResponsesStream } =
  require("../src/main/runtime/transport/model-response-readers.cjs") as {
    readCodexResponsesStream: (
      response: Response,
      requestSummary: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<{ outputText: string; rawResponse: unknown }>;
  };

function responsesStream(
  terminalType: "response.completed" | "response.incomplete",
): Response {
  const response =
    terminalType === "response.incomplete"
      ? {
          id: "resp_1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        }
      : { id: "resp_1", status: "completed", output: [] };
  return new Response(
    [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"{\\"items\\":["}',
      "",
      `event: ${terminalType}`,
      `data: ${JSON.stringify({ type: terminalType, response })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200 },
  );
}

describe("Codex Responses stream reader", () => {
  it("rejects nonempty output when the response is incomplete", async () => {
    await expect(
      readCodexResponsesStream(
        responsesStream("response.incomplete"),
        {},
        { modelProvider: "openai-codex" },
      ),
    ).rejects.toMatchObject({
      failureCategory: "empty-model-response",
      outputTruncated: true,
    });
  });

  it("accepts nonempty output from a completed response", async () => {
    await expect(
      readCodexResponsesStream(
        responsesStream("response.completed"),
        {},
        { modelProvider: "openai-codex" },
      ),
    ).resolves.toMatchObject({ outputText: '{"items":[' });
  });
});
