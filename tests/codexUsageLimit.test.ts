import * as assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  extractCompletedTurn,
  type JsonRecord,
} from "../src/main/codexAppServerProtocol";

const usageLimitMessage =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex " +
  "(https://chatgpt.com/explore/plus), or try again at Oct 11th, 2026 10:21 PM.";

function readFailedTurnError(
  turnError: JsonRecord,
  status = "failed",
): Error & JsonRecord {
  try {
    extractCompletedTurn(
      { params: { turn: { status, error: turnError, items: [] } } },
      "thread-1",
      "turn-1",
    );
  } catch (error) {
    assert.ok(error instanceof Error);
    return error as Error & JsonRecord;
  }
  assert.fail("Expected the failed turn to throw");
}

function assertUsageLimit(error: Error & JsonRecord): void {
  assert.equal(error.httpStatus, 429);
  assert.equal(error.status, 429);
  assert.equal(error.failureCategory, "model-request");
  assert.equal(error.nonRetriable, true);
  assert.equal(error.usageLimitReached, true);
  assert.equal(
    (error.upstreamError as JsonRecord).type,
    "usage_limit_reached",
  );
}

describe("Codex App Server usage-limit failures (#97)", () => {
  it("normalizes the structured Codex signal without matching English text", () => {
    const error = readFailedTurnError({
      message: "계정 사용 한도에 도달했습니다.",
      codexErrorInfo: "usageLimitExceeded",
    });
    assertUsageLimit(error);
    assert.equal(error.message, "계정 사용 한도에 도달했습니다.");
    assert.deepEqual(error.upstreamError, {
      type: "usage_limit_reached",
      message: error.message,
    });
  });

  it("recognizes the plain-text error reported in issue #97", () => {
    const error = readFailedTurnError({ message: usageLimitMessage });
    assertUsageLimit(error);
    assert.equal(error.message, usageLimitMessage);
    assert.deepEqual(error.upstreamError, {
      type: "usage_limit_reached",
      message: usageLimitMessage,
    });
  });

  it("recognizes the legacy message when optional error info is null", () => {
    const error = readFailedTurnError({
      message: `  ${usageLimitMessage}  `,
      codexErrorInfo: null,
    });
    assertUsageLimit(error);
    assert.equal(error.message, usageLimitMessage);
  });

  for (const status of [undefined, 429]) {
    it(`preserves structured reset metadata with HTTP status ${status}`, () => {
      const upstreamError = {
        type: "usage_limit_reached",
        message: "Account quota exhausted.",
        resets_at: 1791742860,
        resets_in_seconds: 3600,
      };
      const error = readFailedTurnError({
        message: JSON.stringify({ status, error: upstreamError }),
      });
      assertUsageLimit(error);
      assert.equal(error.message, upstreamError.message);
      assert.deepEqual(error.upstreamError, upstreamError);
    });
  }

  it("normalizes a structured quota failure even without a message", () => {
    const error = readFailedTurnError({
      codexErrorInfo: "usageLimitExceeded",
    });
    assertUsageLimit(error);
    assert.equal(error.message, "Codex 요청이 실패했습니다.");
  });

  for (const turnError of [
    { message: "Bad Gateway", status: 502 },
    { message: "Connection reset" },
    { message: "Could not read the usage limit." },
    { message: "Too many requests.", status: 429 },
    {
      message: "Too many requests.",
      status: 429,
      codexErrorInfo: "rateLimitExceeded",
    },
    {
      message: usageLimitMessage,
      status: 429,
      codexErrorInfo: "rateLimitExceeded",
    },
    {
      message: JSON.stringify({
        status: 429,
        error: { type: "rate_limit_exceeded", message: usageLimitMessage },
      }),
    },
  ]) {
    it(
      `does not mark a transient or unrelated failure as quota exhaustion: ${JSON.stringify(turnError)}`,
      () => {
        const error = readFailedTurnError(turnError);
        assert.equal(error.usageLimitReached, undefined);
        assert.equal(error.nonRetriable, undefined);
        assert.notEqual(
          (error.upstreamError as JsonRecord | undefined)?.type,
          "usage_limit_reached",
        );
        if (turnError.status !== undefined) {
          assert.equal(error.httpStatus, turnError.status);
        }
      },
    );
  }

  it("preserves unrelated non-retriable upstream failures", () => {
    const upstreamError = {
      type: "invalid_request_error",
      code: "invalid_json_schema",
      message: "The response schema is invalid.",
      param: "text.format.schema",
    };
    const error = readFailedTurnError({
      message: JSON.stringify({ status: 400, error: upstreamError }),
    });
    assert.equal(error.httpStatus, 400);
    assert.equal(error.nonRetriable, true);
    assert.equal(error.usageLimitReached, undefined);
    assert.deepEqual(error.upstreamError, upstreamError);
  });

  it("preserves interrupted-turn handling", () => {
    const error = readFailedTurnError({}, "interrupted");
    assert.equal(error.message, "Codex 요청이 중단되었습니다.");
    assert.equal(error.usageLimitReached, undefined);
    assert.equal(error.httpStatus, undefined);
  });

  it("does not interpret successful model output as a quota error", () => {
    const result = extractCompletedTurn(
      {
        params: {
          turn: {
            status: "completed",
            items: [
              {
                type: "agentMessage",
                id: "message-1",
                phase: "final_answer",
                text: usageLimitMessage,
              },
            ],
          },
        },
      },
      "thread-1",
      "turn-1",
    );
    assert.equal(result.text, usageLimitMessage);
  });
});
