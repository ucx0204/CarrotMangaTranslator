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
      { responseTokenLimitSource: "max-output-tokens" },
      Date.now(),
    );

    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("최대 출력 토큰"),
      failureCategory: "empty-model-response",
      outputTruncated: true,
      failureGuidance: "increase-max-output-tokens",
    });
  });

  it("maps a context-capped truncated response to context guidance", async () => {
    await expect(
      readChatCompletionResult(
        chatResponse('{"items":[', "length"),
        {},
        { responseTokenLimitSource: "work-context-budget" },
        Date.now(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("작품 정보 예산"),
      outputTruncated: true,
      failureGuidance: "increase-work-context-budget",
    });
  });

  it("maps a local context-capped response to context-length guidance", async () => {
    await expect(
      readChatCompletionResult(
        chatResponse('{"items":[', "length"),
        {},
        { responseTokenLimitSource: "context-length" },
        Date.now(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("컨텍스트 길이"),
      outputTruncated: true,
      failureGuidance: "increase-context-length",
    });
  });

  it("does not blame settings when the internal structured cap was limiting", async () => {
    const promise = readChatCompletionResult(
      chatResponse('{"items":[', "length"),
      {},
      { responseTokenLimitSource: "structured-request-budget" },
      Date.now(),
    );

    await expect(promise).rejects.not.toHaveProperty("failureGuidance");
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("앱 내부 구조화 출력 한도"),
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
