import { describe, expect, it, vi } from "vitest";
import { reportFluxInpaintSummary } from "../src/main/inpainting/fluxInpaintSummary";

describe("Flux inpainting completion summary", () => {
  it("fails a required run when any target window is skipped", () => {
    const warn = vi.fn();

    expect(() =>
      reportFluxInpaintSummary(
        {
          coveredWindows: 0,
          eligibleWindows: 2,
          processedWindows: 1,
          unchangedWindows: 0,
          unchangedStats: [],
        },
        { warn },
        true,
      ),
    ).toThrow("인페인팅 결과가 생성되지 않았습니다.");
    expect(warn).toHaveBeenCalledWith(
      "Flux inpainting skipped one or more eligible crops",
      { eligibleWindows: 2, processedWindows: 1 },
    );
  });

  it("accepts a target window whose pixels are fully owned by an earlier crop", () => {
    const warn = vi.fn();

    expect(() =>
      reportFluxInpaintSummary(
        {
          coveredWindows: 1,
          eligibleWindows: 2,
          processedWindows: 1,
          unchangedWindows: 0,
          unchangedStats: [],
        },
        { warn },
        true,
      ),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails a required run when any processed target window is unchanged", () => {
    const warn = vi.fn();

    expect(() =>
      reportFluxInpaintSummary(
        {
          coveredWindows: 0,
          eligibleWindows: 2,
          processedWindows: 2,
          unchangedWindows: 1,
          unchangedStats: [{ crop: 2, changedRatio: 0, meanDelta: 0 }],
        },
        { warn },
        true,
      ),
    ).toThrow("인페인팅 결과가 생성되지 않았습니다.");
    expect(warn).toHaveBeenCalledWith(
      "Flux inpainting left one or more masked crops effectively unchanged",
      expect.objectContaining({
        processedWindows: 2,
        unchangedStats: [expect.objectContaining({ crop: 2 })],
      }),
    );
  });
});
