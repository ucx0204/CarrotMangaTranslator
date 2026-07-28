import { describe, expect, it } from "vitest";
import { isUsableBubbleLayout } from "../src/shared/bubbleLayout";
import { buildManualBubbleLayoutPatch } from "../src/renderer/src/lib/manualBubbleLayout";

describe("manual bubble layout", () => {
  it("turns a page polygon into valid manual provenance and local spans", () => {
    const patch = buildManualBubbleLayoutPatch(
      [
        { x: 160, y: 120 },
        { x: 440, y: 100 },
        { x: 520, y: 260 },
        { x: 420, y: 420 },
        { x: 140, y: 390 },
        { x: 80, y: 240 },
      ],
      "horizontal",
    );

    expect(patch?.renderBbox).toEqual({
      x: 80,
      y: 100,
      w: 440,
      h: 320,
    });
    expect(patch?.renderBboxSpace).toBe("normalized_1000");
    expect(patch?.bubbleLayout).toMatchObject({
      direction: "horizontal",
      confidence: 1,
      origin: "manual",
      modelId: "manual-shape-v1",
    });
    expect(patch?.bubbleLayout).not.toHaveProperty("sourceImageRevision");
    expect(isUsableBubbleLayout(patch?.bubbleLayout)).toBe(true);
    expect(patch?.bubbleLayout.regions[0]?.spans.length).toBeGreaterThan(4);
  });

  it("uses the selected block direction without changing or guessing it", () => {
    const patch = buildManualBubbleLayoutPatch(
      [
        { x: 100, y: 100 },
        { x: 400, y: 100 },
        { x: 400, y: 700 },
        { x: 100, y: 700 },
      ],
      "vertical",
    );

    expect(patch?.bubbleLayout.direction).toBe("vertical");
    expect(isUsableBubbleLayout(patch?.bubbleLayout)).toBe(true);
  });

  it("rejects incomplete and tiny polygons", () => {
    expect(
      buildManualBubbleLayoutPatch(
        [
          { x: 100, y: 100 },
          { x: 400, y: 100 },
        ],
        "horizontal",
      ),
    ).toBeNull();
    expect(
      buildManualBubbleLayoutPatch(
        [
          { x: 100, y: 100 },
          { x: 105, y: 100 },
          { x: 105, y: 105 },
          { x: 100, y: 105 },
        ],
        "horizontal",
      ),
    ).toBeNull();
  });
});
