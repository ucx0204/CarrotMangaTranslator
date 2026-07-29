import { describe, expect, it } from "vitest";
import type { BlockBubbleCandidate } from "../src/main/bubbleLayout/bubbleBlockAssociation";
import {
  repairFragmentedBubbleRegions,
  type ScoredBubbleRegion,
} from "../src/main/bubbleLayout/bubbleFragmentRepair";
import type { RefinedBubbleRegion } from "../src/main/bubbleLayout/bubbleMaskTypes";
import type { BBox, TranslationBlock } from "../src/shared/textTypes";

const WIDTH = 120;
const HEIGHT = 80;

describe("fragmented bubble re-segmentation", () => {
  it("re-segments a #712-style main region plus tall shard from OCR markers", () => {
    const bitmap = createBitmap(25);
    paintEllipse(bitmap, 60, 40, 45, 30, 245);
    const blockBounds = { x: 35, y: 24, w: 50, h: 32 };
    const main = scoredRegion({ x: 35, y: 24, w: 38, h: 32 });
    const shard = scoredRegion({ x: 81, y: 24, w: 4, h: 32 });
    const repaired = repairFragmentedBubbleRegions({
      block: block(blockBounds),
      candidates: [
        candidate({ x: 15, y: 8, w: 80, h: 64 }, blockBounds, 0.92),
        candidate({ x: 90, y: 8, w: 18, h: 64 }, blockBounds, 0.84),
      ],
      initialRegions: [main, shard],
      blockBounds,
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      policy: "balanced",
      outlineWidthPx: 1,
    });

    expect(repaired).not.toBeNull();
    expect(repaired).not.toBeUndefined();
    expect(repaired).toHaveLength(1);
    expect(repaired?.[0]?.region.bounds.x).toBeLessThan(blockBounds.x);
    expect(
      (repaired?.[0]?.region.bounds.x ?? 0) +
        (repaired?.[0]?.region.bounds.w ?? 0),
    ).toBeGreaterThan(blockBounds.x + blockBounds.w);
  });

  it("leaves two substantial connected-balloon regions on the normal path", () => {
    const blockBounds = { x: 20, y: 20, w: 80, h: 40 };
    const left = scoredRegion({ x: 20, y: 20, w: 38, h: 40 });
    const right = scoredRegion({ x: 62, y: 20, w: 38, h: 40 });

    expect(
      repairFragmentedBubbleRegions({
        block: block(blockBounds),
        candidates: [
          candidate({ x: 10, y: 10, w: 50, h: 60 }, blockBounds, 0.92),
          candidate({ x: 60, y: 10, w: 50, h: 60 }, blockBounds, 0.91),
        ],
        initialRegions: [left, right],
        blockBounds,
        bitmap: createBitmap(245),
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        policy: "balanced",
        outlineWidthPx: 1,
      }),
    ).toBeUndefined();
  });

  it("disables an unrepaired split claimed by redundant containing candidates", () => {
    const blockBounds = { x: 40, y: 20, w: 40, h: 40 };
    const left = scoredRegion({ x: 40, y: 20, w: 18, h: 40 });
    const right = scoredRegion({ x: 62, y: 20, w: 18, h: 40 });

    expect(
      repairFragmentedBubbleRegions({
        block: block(blockBounds),
        candidates: [
          candidate({ x: 30, y: 10, w: 60, h: 60 }, blockBounds, 0.92),
          candidate({ x: 10, y: 0, w: 100, h: 80 }, blockBounds, 0.84),
        ],
        initialRegions: [left, right],
        blockBounds,
        bitmap: createBitmap(245),
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        policy: "balanced",
        outlineWidthPx: 1,
      }),
    ).toBeNull();
  });

  it("disables bubble fitting when a suspicious shard cannot be repaired", () => {
    const blockBounds = { x: 50, y: 25, w: 20, h: 30 };
    const main = scoredRegion({ x: 50, y: 25, w: 15, h: 30 });
    const shard = scoredRegion({ x: 68, y: 25, w: 2, h: 30 });

    expect(
      repairFragmentedBubbleRegions({
        block: block(blockBounds),
        candidates: [
          candidate({ x: 0, y: 0, w: WIDTH, h: HEIGHT }, blockBounds, 0.92),
        ],
        initialRegions: [main, shard],
        blockBounds,
        bitmap: createBitmap(25),
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        policy: "balanced",
        outlineWidthPx: 1,
      }),
    ).toBeNull();
  });
});

function scoredRegion(bounds: BBox): ScoredBubbleRegion {
  return {
    region: filledRegion(bounds),
    confidence: 0.85,
    insetPx: 3,
  };
}

function filledRegion(bounds: BBox): RefinedBubbleRegion {
  const width = Math.round(bounds.w);
  const height = Math.round(bounds.h);
  return {
    bounds,
    width,
    height,
    area: width * height,
    mask: new Uint8Array(width * height).fill(1),
  };
}

function candidate(
  bubbleBox: BBox,
  promptBox: BBox,
  score: number,
): BlockBubbleCandidate {
  return {
    bubbleDetection: {
      labelId: 0,
      label: "bubble",
      box: [
        bubbleBox.x,
        bubbleBox.y,
        bubbleBox.x + bubbleBox.w,
        bubbleBox.y + bubbleBox.h,
      ],
      score,
    },
    bubbleBox,
    promptBoxes: [promptBox],
    score,
  };
}

function block(bounds: BBox): TranslationBlock {
  return {
    id: "fragmented",
    type: "nonsolid",
    bbox: bounds,
    bboxSpace: "pixels",
    sourceText: "運んで",
    translatedText: "옮겨 줘",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 18,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function createBitmap(value: number): Uint8Array {
  const bitmap = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    bitmap[index * 4] = value;
    bitmap[index * 4 + 1] = value;
    bitmap[index * 4 + 2] = value;
    bitmap[index * 4 + 3] = 255;
  }
  return bitmap;
}

function paintEllipse(
  bitmap: Uint8Array,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  value: number,
): void {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const dx = (x - centerX) / radiusX;
      const dy = (y - centerY) / radiusY;
      if (dx * dx + dy * dy > 1) continue;
      const index = (y * WIDTH + x) * 4;
      bitmap[index] = value;
      bitmap[index + 1] = value;
      bitmap[index + 2] = value;
    }
  }
}
