import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "../src/renderer/src/lib/errorPresentation";

describe("error presentation boundary", () => {
  it("does not expose paths or tokens from raw runtime errors", () => {
    const rawError = new Error(
      "request failed at C:\\Users\\alice\\secret with token sk-private",
    );

    expect(formatErrorMessage(rawError, "작업을 완료하지 못했습니다.")).toBe(
      "작업을 완료하지 못했습니다.",
    );
  });

  it("uses the localized boundary message for non-Error failures", () => {
    expect(formatErrorMessage(null, "다시 시도해 주세요.")).toBe(
      "다시 시도해 주세요.",
    );
  });
});
