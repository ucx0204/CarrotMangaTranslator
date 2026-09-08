import { describe, expect, it } from "vitest";
import { buildBubbleShapeProfile } from "../src/main/bubbleLayout/bubbleShapeProfileBuilder";
import type { RefinedBubbleRegion } from "../src/main/bubbleLayout/bubbleMaskTypes";

describe("bubble shape profile builder", () => {
  it.each([
    { direction: "horizontal", padding: 0 },
    { direction: "vertical", padding: 0 },
    { direction: "horizontal", padding: 0.12 },
    { direction: "vertical", padding: 0.12 },
    { direction: "horizontal", padding: 0.7 },
    { direction: "vertical", padding: 0.7 },
  ] as const)(
    "keeps every $direction span inside a concave mask at padding $padding",
    ({ direction, padding }) => {
      const size = 200;
      const region = rectangularRegion(0, 0, size, size);
      // A connected U shape has two disjoint runs in most scanlines.
      for (let block = 0; block < 180; block += 1) {
        for (let inline = 65; inline < 130; inline += 1) {
          const x = direction === "horizontal" ? inline : block;
          const y = direction === "horizontal" ? block : inline;
          region.mask[y * size + x] = 0;
        }
      }
      const result = buildBubbleShapeProfile({
        regions: [region],
        pageWidth: size,
        pageHeight: size,
        renderDirection: direction,
        sourceDirection: direction,
        confidence: 1,
        modelId: "test",
        sourceImageRevision: "revision",
        insetPx: 0,
        regionGapPx: 0,
        paddingRatio: padding,
      });
      expect(result).not.toBeNull();
      const spans =
        result?.bubbleLayout.regions.flatMap((item) => item.spans) ?? [];
      expect(spans.some((span) => span.blockStart < 0.8)).toBe(true);
      if (!result) throw new Error("Missing safe concave profile");
      const box = result.renderBbox;
      const blockOffset =
        ((direction === "horizontal" ? box.y : box.x) * size) / 1000;
      const inlineOffset =
        ((direction === "horizontal" ? box.x : box.y) * size) / 1000;
      const blockSize =
        ((direction === "horizontal" ? box.h : box.w) * size) / 1000;
      const inlineSize =
        ((direction === "horizontal" ? box.w : box.h) * size) / 1000;
      for (const span of spans) {
        for (
          let block = Math.ceil(blockOffset + span.blockStart * blockSize);
          block < blockOffset + span.blockEnd * blockSize - 1e-8;
          block += 1
        ) {
          for (
            let inline = Math.ceil(
              inlineOffset + span.inlineStart * inlineSize,
            );
            inline < inlineOffset + span.inlineEnd * inlineSize - 1e-8;
            inline += 1
          ) {
            const x = direction === "horizontal" ? inline : block;
            const y = direction === "horizontal" ? block : inline;
            expect(region.mask[y * size + x], `outside mask at ${x},${y}`).toBe(
              1,
            );
          }
        }
      }
    },
  );

  it("keeps fused balloon lobes as ordered independent regions", () => {
    const left = rectangularRegion(10, 20, 30, 30);
    const right = rectangularRegion(70, 18, 32, 34);
    const result = buildBubbleShapeProfile({
      regions: [left, right],
      pageWidth: 120,
      pageHeight: 80,
      renderDirection: "horizontal",
      sourceDirection: "vertical",
      confidence: 0.9,
      modelId: "test-model",
      sourceImageRevision: "revision",
      insetPx: 4,
      regionGapPx: 4,
    });

    expect(result?.bubbleLayout.regions).toHaveLength(2);
    const firstSpan = result?.bubbleLayout.regions[0].spans[0];
    const secondSpan = result?.bubbleLayout.regions[1].spans[0];
    expect(firstSpan?.inlineStart).toBeGreaterThan(
      secondSpan?.inlineStart ?? 1,
    );
    expect(result?.renderBboxSpace).toBe("normalized_1000");
    expect(result?.bubbleLayout.origin).toBe("detected");
    expect(result?.bubbleLayout.modelId).toBe("test-model");
    expect(result?.bubbleLayout.sourceImageRevision).toBe("revision");
  });

  it("rejects a padded band with no surviving occupied scanline", () => {
    const region = rectangularRegion(0, 0, 20, 200);
    region.mask.fill(0, 20 * 4, 20 * 196);
    expect(
      buildBubbleShapeProfile({
        regions: [region],
        pageWidth: 20,
        pageHeight: 200,
        renderDirection: "horizontal",
        sourceDirection: "horizontal",
        confidence: 1,
        modelId: "test",
        sourceImageRevision: "revision",
        insetPx: 0,
        regionGapPx: 0,
        paddingRatio: 0.7,
      }),
    ).toBeNull();
  });

  it("intersects every scanline in a band instead of using only its center", () => {
    const region: RefinedBubbleRegion = {
      bounds: { x: 0, y: 0, w: 10, h: 4 },
      width: 10,
      height: 4,
      area: 34,
      mask: new Uint8Array([
        0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0,
      ]),
    };
    const result = buildBubbleShapeProfile({
      regions: [region],
      pageWidth: 10,
      pageHeight: 4,
      renderDirection: "horizontal",
      sourceDirection: "horizontal",
      confidence: 1,
      modelId: "test",
      sourceImageRevision: "revision",
      insetPx: 0,
      regionGapPx: 4,
      paddingRatio: 0,
    });
    const spans = result?.bubbleLayout.regions[0].spans ?? [];
    expect(spans[0].inlineStart).toBeCloseTo(0.2);
    expect(spans[0].inlineEnd).toBeCloseTo(0.8);
  });

  it("persists overlapping same-block lobes as disjoint normalized spans", () => {
    const result = buildBubbleShapeProfile({
      regions: [
        rectangularRegion(5, 20, 42, 44),
        rectangularRegion(31, 5, 44, 46),
      ],
      pageWidth: 100,
      pageHeight: 80,
      renderDirection: "horizontal",
      sourceDirection: "vertical",
      confidence: 0.9,
      modelId: "test",
      sourceImageRevision: "revision",
      insetPx: 3,
      regionGapPx: 4,
      paddingRatio: 0,
    });

    expect(result?.bubbleLayout.regions).toHaveLength(2);
    const [first, second] = result?.bubbleLayout.regions ?? [];
    const renderWidthPx = ((result?.renderBbox.w ?? 0) / 1000) * 100;
    let comparedBands = 0;
    for (const left of first?.spans ?? []) {
      for (const right of second?.spans ?? []) {
        const blockOverlap =
          Math.min(left.blockEnd, right.blockEnd) -
          Math.max(left.blockStart, right.blockStart);
        if (blockOverlap <= 0) continue;
        comparedBands += 1;
        const inlineGap =
          Math.max(left.inlineStart, right.inlineStart) -
          Math.min(left.inlineEnd, right.inlineEnd);
        expect(inlineGap * renderWidthPx).toBeGreaterThanOrEqual(4 - 1e-8);
      }
    }
    expect(comparedBands).toBeGreaterThan(0);
  });

  it("drops a tiny separated region when one region contains nearly all text", () => {
    const result = buildBubbleShapeProfile({
      regions: [
        rectangularRegion(10, 10, 80, 80),
        rectangularRegion(96, 10, 12, 12),
      ],
      pageWidth: 120,
      pageHeight: 120,
      textBounds: { x: 20, y: 20, w: 70, h: 70 },
      renderDirection: "horizontal",
      sourceDirection: "horizontal",
      confidence: 0.9,
      modelId: "test",
      sourceImageRevision: "revision",
      insetPx: 3,
      regionGapPx: 4,
      paddingRatio: 0,
    });

    expect(result?.bubbleLayout.regions).toHaveLength(1);
    expect(result?.renderBbox.x).toBeCloseTo((10 / 120) * 1000);
    expect(result?.renderBbox.w).toBeCloseTo((80 / 120) * 1000);
  });

  it("keeps two regions when both contain meaningful text", () => {
    const result = buildBubbleShapeProfile({
      regions: [
        rectangularRegion(10, 10, 40, 80),
        rectangularRegion(60, 10, 40, 80),
      ],
      pageWidth: 120,
      pageHeight: 120,
      textBounds: { x: 20, y: 20, w: 70, h: 60 },
      renderDirection: "horizontal",
      sourceDirection: "horizontal",
      confidence: 0.9,
      modelId: "test",
      sourceImageRevision: "revision",
      insetPx: 3,
      regionGapPx: 4,
    });

    expect(result?.bubbleLayout.regions).toHaveLength(2);
  });

  it("keeps a non-empty 30% render area at the maximum padding", () => {
    const result = buildBubbleShapeProfile({
      regions: [rectangularRegion(10, 20, 80, 60)],
      pageWidth: 100,
      pageHeight: 100,
      renderDirection: "horizontal",
      sourceDirection: "horizontal",
      confidence: 0.9,
      modelId: "test",
      sourceImageRevision: "revision",
      insetPx: 3,
      regionGapPx: 4,
      paddingRatio: 0.7,
    });

    expect(result?.renderBbox.x).toBeCloseTo(380);
    expect(result?.renderBbox.y).toBeCloseTo(410);
    expect(result?.renderBbox.w).toBeCloseTo(240);
    expect(result?.renderBbox.h).toBeCloseTo(180);
    expect(result?.bubbleLayout.regions[0]?.spans[0]?.blockStart).toBeCloseTo(
      0,
    );
    expect(result?.bubbleLayout.regions[0]?.spans[0]?.inlineStart).toBeCloseTo(
      0,
    );
    expect(result?.bubbleLayout.regions[0]?.spans[0]?.inlineEnd).toBeCloseTo(1);
    expect(result?.bubbleLayout.regions[0]?.spans.at(-1)?.blockEnd).toBeCloseTo(
      1,
    );
  });
});

function rectangularRegion(
  x: number,
  y: number,
  width: number,
  height: number,
): RefinedBubbleRegion {
  return {
    bounds: { x, y, w: width, h: height },
    width,
    height,
    area: width * height,
    mask: new Uint8Array(width * height).fill(1),
  };
}
