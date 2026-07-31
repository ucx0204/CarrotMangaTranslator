import { describe, expect, it } from "vitest";

const { readChatCompletionResult } =
  require("../src/main/runtime/transport/chat-completion.cjs") as {
    readChatCompletionResult: (
      response: Response,
      options: Record<string, unknown>,
      requestSummary: Record<string, unknown>,
      requestStartedAt: number,
    ) => Promise<{ outputText: string }>;
  };

function chatResponse(
  content: string,
  finishReason: string,
  extraMessage: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finishReason,
          message: { content, ...extraMessage },
        },
      ],
    }),
    { status: 200 },
  );
}

describe("chat completion terminal reasons", () => {
  it("rejects a nonempty structured response cut off by max_tokens", async () => {
    const promise = readChatCompletionResult(
      chatResponse('{"items":[', "length"),
      {},
      {},
      Date.now(),
    );

    await expect(promise).rejects.toMatchObject({
      failureCategory: "empty-model-response",
      outputTruncated: true,
    });
  });

  it("accepts final content even when the provider also returns reasoning", async () => {
    await expect(
      readChatCompletionResult(
        chatResponse('{"items":[]}', "stop", {
          reasoning_content: "internal thoughts",
        }),
        {},
        {},
        Date.now(),
      ),
    ).resolves.toMatchObject({ outputText: '{"items":[]}' });
  });
});
