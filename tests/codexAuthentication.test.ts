import { describe, expect, it } from "vitest";
import { normalizeCodexAuthenticationError } from "../src/main/codexAuthentication";
import { extractCompletedTurn } from "../src/main/codexAppServerProtocol";
import { extractCodexImageTurn } from "../src/main/codexAppServerImageResult";

const revoked =
  "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.";
describe("Codex revoked authentication", () => {
  it.each([extractCompletedTurn, extractCodexImageTurn])(
    "retains the actual authentication error for text and image turns",
    (extract) => {
      expect(() =>
        extract(
          {
            params: {
              turn: {
                status: "failed",
                error: { message: revoked },
                items: [],
              },
            },
          },
          "thread",
          "turn",
        ),
      ).toThrow("다시 로그인");
    },
  );
  it("maps revoked credentials to non-retriable 401 instead of 502", () => {
    expect(normalizeCodexAuthenticationError(new Error(revoked))).toMatchObject(
      {
        httpStatus: 401,
        nonRetriable: true,
        upstreamError: { type: "codex_authentication_required" },
      },
    );
  });
  it("does not treat network or quota failures as signed out", () => {
    const error = new Error("Unable to refresh model catalog: network timeout");
    expect(normalizeCodexAuthenticationError(error)).toBe(error);
  });
  it("shows the sign-in action and disables retry through the runtime HTTP boundary", () => {
    const {
      createHttpFailureError,
    } = require("../src/main/runtime/transport/model-http-errors.cjs");
    const error = createHttpFailureError(
      { modelProvider: "openai-codex" },
      {},
      new Response("", { status: 401 }),
      JSON.stringify({ error: { type: "codex_authentication_required" } }),
    );
    expect(error).toMatchObject({ nonRetriable: true, status: 401 });
    expect(error.message).toContain("다시 로그인");
  });
});

describe("Codex image results", () => {
  it("extracts completed images from a completed turn even alongside other items", () => {
    const result = extractCodexImageTurn(
      {
        params: {
          turn: {
            status: "completed",
            items: [
              { type: "agentMessage", text: "done" },
              {
                type: "imageGeneration",
                status: "completed",
                result: "cG5n",
                savedPath: "output.png",
              },
            ],
          },
        },
      },
      "thread",
      "turn",
    );
    expect(result.itemId).toBeNull();
    expect(JSON.parse(result.text)).toEqual({
      result: "cG5n",
      savedPath: "output.png",
    });
  });
  it("reports a missing image separately from a failed image operation", () => {
    expect(() => extractCodexImageTurn({}, "t", "r")).toThrow(
      "결과를 받지 못했습니다",
    );
    expect(() =>
      extractCodexImageTurn(
        {
          params: {
            item: {
              type: "imageGeneration",
              status: "failed",
              failure: "render denied",
            },
          },
        },
        "t",
        "r",
      ),
    ).toThrow("render denied");
    expect(() =>
      extractCodexImageTurn(
        { params: { item: { type: "imageGeneration", status: "cancelled" } } },
        "t",
        "r",
      ),
    ).toThrow("cancelled");
  });
});
