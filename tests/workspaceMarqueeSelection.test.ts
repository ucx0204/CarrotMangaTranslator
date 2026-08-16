import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { createIdentityWarpTransform } from "../src/shared/blockTransforms";
import {
  resolveMarqueeHitBlockIds,
  resolveMarqueeImagePoint,
} from "../src/renderer/src/hooks/useWorkspaceMarqueeSelectionHandlers";

describe("workspace marquee selection", () => {
  it("selects a bubble-fitted block at its render box, not its source box", () => {
    const page = makePage([
      makeBlock({
        bbox: { x: 100, y: 100, w: 180, h: 120 },
        renderBbox: { x: 620, y: 420, w: 240, h: 180 },
        renderBboxSpace: "normalized_1000",
      }),
    ]);

    expect(
      resolveMarqueeHitBlockIds(page, {
        x: 640,
        y: 440,
        w: 80,
        h: 80,
      }),
    ).toEqual(["block-1"]);
    expect(
      resolveMarqueeHitBlockIds(page, {
        x: 110,
        y: 110,
        w: 80,
        h: 80,
      }),
    ).toEqual([]);
  });

  it("normalizes a legacy pixel-space source box before hit testing", () => {
    const page = makePage(
      [
        makeBlock({
          bbox: { x: 1200, y: 200, w: 400, h: 200 },
          bboxSpace: "pixels",
        }),
      ],
      { width: 2000, height: 1000 },
    );

    expect(
      resolveMarqueeHitBlockIds(page, {
        x: 620,
        y: 220,
        w: 80,
        h: 80,
      }),
    ).toEqual(["block-1"]);
  });

  it.each([
    {
      name: "rotation",
      patch: { rotationDeg: 90 },
      marquee: { x: 460, y: 355, w: 20, h: 20 },
    },
    {
      name: "perspective",
      patch: {
        perspectiveTransform: {
          version: 1,
          corners: [
            { x: -0.5, y: 0 },
            { x: 1.5, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
        } satisfies NonNullable<TranslationBlock["perspectiveTransform"]>,
      },
      marquee: { x: 310, y: 410, w: 20, h: 20 },
    },
    {
      name: "warp",
      patch: { warpTransform: expandedTopLeftWarp() },
      marquee: { x: 310, y: 310, w: 20, h: 20 },
    },
  ])(
    "uses the transformed frame for $name hit testing",
    ({ patch, marquee }) => {
      const page = makePage([
        makeBlock({
          bbox: { x: 50, y: 50, w: 100, h: 100 },
          renderBbox: { x: 400, y: 400, w: 200, h: 100 },
          renderBboxSpace: "normalized_1000",
          ...patch,
        }),
      ]);

      expect(resolveMarqueeHitBlockIds(page, marquee)).toEqual(["block-1"]);
    },
  );

  it("does not select an empty corner of a rotated frame's bounding box", () => {
    const page = makePage([
      makeBlock({
        bbox: { x: 50, y: 50, w: 100, h: 100 },
        renderBbox: { x: 400, y: 400, w: 200, h: 100 },
        renderBboxSpace: "normalized_1000",
        rotationDeg: 45,
      }),
    ]);

    expect(
      resolveMarqueeHitBlockIds(page, { x: 394, y: 344, w: 14, h: 14 }),
    ).toEqual([]);
    expect(
      resolveMarqueeHitBlockIds(page, { x: 458, y: 342, w: 14, h: 14 }),
    ).toEqual(["block-1"]);
  });

  it("keeps marquee coordinates in the editable area outside the image", () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 };

    expect(
      resolveMarqueeImagePoint({ clientX: -30, clientY: 170 }, rect),
    ).toEqual({ x: -200, y: 1500 });
    expect(
      resolveMarqueeImagePoint({ clientX: -2000, clientY: 2000 }, rect),
    ).toEqual({ x: -4000, y: 5000 });
  });
});

function expandedTopLeftWarp(): NonNullable<TranslationBlock["warpTransform"]> {
  const transform = createIdentityWarpTransform(3);
  transform.points[0] = { x: -0.5, y: -1 };
  return transform;
}

function makePage(
  blocks: TranslationBlock[],
  size: { width: number; height: number } = { width: 1000, height: 1000 },
): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width: size.width,
    height: size.height,
    blocks,
    analysisStatus: "idle",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    sourceText: "原文",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    ...patch,
  };
}
