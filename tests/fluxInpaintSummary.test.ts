import { describe, expect, it, vi } from "vitest";
import { reportFluxInpaintSummary } from "../src/main/inpainting/fluxInpaintSummary";

describe("Flux inpainting completion summary", () => {
  it("keeps a required run when one target window succeeds and another is skipped", () => {
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
    ).not.toThrow();
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

  it("keeps a required run when one processed target changes", () => {
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
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "Flux inpainting left one or more masked crops effectively unchanged",
      expect.objectContaining({
        processedWindows: 2,
        unchangedStats: [expect.objectContaining({ crop: 2 })],
      }),
    );
  });

  it("fails a required run when every processed target is unchanged", () => {
    const warn = vi.fn();

    expect(() =>
      reportFluxInpaintSummary(
        {
          coveredWindows: 0,
          eligibleWindows: 2,
          processedWindows: 2,
          unchangedWindows: 2,
          unchangedStats: [
            { crop: 1, changedRatio: 0, meanDelta: 0 },
            { crop: 2, changedRatio: 0, meanDelta: 0 },
          ],
        },
        { warn },
        true,
      ),
    ).toThrow("인페인팅 결과가 생성되지 않았습니다.");
  });

  it("fails a required run when every eligible target is skipped", () => {
    const warn = vi.fn();

    expect(() =>
      reportFluxInpaintSummary(
        {
          coveredWindows: 0,
          eligibleWindows: 2,
          processedWindows: 0,
          unchangedWindows: 0,
          unchangedStats: [],
        },
        { warn },
        true,
      ),
    ).toThrow("인페인팅 결과가 생성되지 않았습니다.");
  });
});
