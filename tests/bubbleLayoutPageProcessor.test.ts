import { describe, expect, it } from "vitest";
import {
  processDetectedBubbleLayouts,
  resolveBubbleLayoutBlockRevision,
} from "../src/main/bubbleLayout/bubbleLayoutPageProcessor";
import { isUsableAutomaticBubbleRegionSet } from "../src/main/bubbleLayout/bubbleFragmentRepair";
import type { RefinedBubbleRegion } from "../src/main/bubbleLayout/bubbleMaskTypes";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { buildPatternPageMask } from "../src/main/inpainting/patternPageMask";
import type { MangaPage } from "../src/shared/libraryTypes";
import type {
  ComicDetectionLabelId,
  ComicPageDetection,
} from "../src/main/bubbleLayout/contracts";
import type { TranslationBlock } from "../src/shared/textTypes";

const WIDTH = 120;
const HEIGHT = 80;

describe("bubble layout page processor", () => {
  it("creates two shape regions without ever patching the OCR bbox", () => {
    const bitmap = createBitmap(25);
    paintCircle(bitmap, 32, 40, 24, 245);
    paintCircle(bitmap, 88, 40, 24, 245);
    const page = createPage();
    const patches = processDetectedBubbleLayouts({
      page,
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [5, 12, 59, 68], 0.96),
        detection(0, [61, 12, 115, 68], 0.95),
        detection(1, [20, 28, 45, 52], 0.97),
        detection(1, [75, 28, 101, 52], 0.96),
      ],
      policy: "maximize",
      pageRevision: "page-revision",
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].bubbleLayout?.regions).toHaveLength(2);
    expect(Object.hasOwn(patches[0], "bbox")).toBe(false);
    expect(page.blocks[0].bbox).toEqual({ x: 150, y: 225, w: 700, h: 450 });
  });

  it("falls back to the OCR box when a match fragments into three regions", () => {
    const bitmap = createBitmap(25);
    paintCircle(bitmap, 22, 40, 16, 245);
    paintCircle(bitmap, 60, 40, 16, 245);
    paintCircle(bitmap, 98, 40, 16, 245);
    const page = createPage();
    page.blocks[0] = {
      ...page.blocks[0],
      renderBbox: { x: 50, y: 100, w: 900, h: 800 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: generatedBubbleLayout(),
    };

    const patches = processDetectedBubbleLayouts({
      page,
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [4, 20, 40, 60], 0.97),
        detection(0, [42, 20, 78, 60], 0.96),
        detection(0, [80, 20, 116, 60], 0.95),
        detection(1, [12, 30, 32, 50], 0.98),
        detection(1, [50, 30, 70, 50], 0.97),
        detection(1, [88, 30, 108, 50], 0.96),
      ],
      policy: "balanced",
      pageRevision: "page-revision",
    });

    expect(patches).toEqual([
      {
        blockId: "merged",
        renderBbox: null,
        renderBboxSpace: null,
        bubbleLayout: null,
      },
    ]);
  });

  it("rejects a two-region match when one sliver barely covers the OCR block", () => {
    const blockBounds = { x: 0, y: 0, w: 20, h: 20 };
    const main = filledRegion({ x: 0, y: 0, w: 12, h: 20 });
    const sliver = filledRegion({ x: 18, y: 0, w: 2, h: 20 });

    expect(isUsableAutomaticBubbleRegionSet([main, sliver], blockBounds)).toBe(
      false,
    );
    expect(
      isUsableAutomaticBubbleRegionSet(
        [main, filledRegion({ x: 12, y: 0, w: 8, h: 20 })],
        blockBounds,
      ),
    ).toBe(true);
  });

  it("leaves an unrecognized block unchanged", () => {
    const patches = processDetectedBubbleLayouts({
      page: createPage(),
      bitmap: createBitmap(240),
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [],
      policy: "safe",
      pageRevision: "page-revision",
    });
    expect(patches).toEqual([]);
  });

  it("falls back to a safe detector inset when original ink still ruins refinement", () => {
    const bitmap = createBitmap(20);
    paintCircle(bitmap, 60, 40, 32, 245);
    paintRect(bitmap, 58, 8, 5, 64, 20);
    const page = createPage();
    page.inpaintedImagePath = undefined;

    const patches = processDetectedBubbleLayouts({
      page,
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [24, 5, 96, 75], 0.97),
        detection(1, [45, 18, 75, 62], 0.98),
      ],
      policy: "balanced",
      pageRevision: "original-page-revision",
      repairOriginalTextInk: true,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].bubbleLayout?.regions).toHaveLength(1);
    expect(patchBoundsInPixels(patches[0]).w).toBeGreaterThan(55);
    const spans = patches[0].bubbleLayout?.regions[0].spans ?? [];
    expect(spans[0].inlineEnd - spans[0].inlineStart).toBeLessThan(0.5);
    expect(
      spans[Math.floor(spans.length / 2)].inlineEnd -
        spans[Math.floor(spans.length / 2)].inlineStart,
    ).toBeGreaterThan(0.8);
  });

  it("does not force an original-image fallback for an unbounded detector box", () => {
    const page = createPage();
    page.inpaintedImagePath = undefined;
    page.blocks[0].bbox = { x: 420, y: 350, w: 160, h: 300 };

    const patches = processDetectedBubbleLayouts({
      page,
      bitmap: createBitmap(245),
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [0, 0, WIDTH, HEIGHT], 0.99),
        detection(1, [50, 30, 70, 50], 0.99),
      ],
      policy: "balanced",
      pageRevision: "original-page-revision",
      repairOriginalTextInk: true,
    });

    expect(patches).toEqual([]);
  });

  it("invalidates generated geometry when its OCR anchor or direction changes", () => {
    const block = createPage().blocks[0];
    const baseline = resolveBubbleLayoutBlockRevision("page-revision", block);

    expect(
      resolveBubbleLayoutBlockRevision("page-revision", {
        ...block,
        bbox: { ...block.bbox, x: block.bbox.x + 1 },
      }),
    ).not.toBe(baseline);
    expect(
      resolveBubbleLayoutBlockRevision("page-revision", {
        ...block,
        renderDirection: "vertical",
      }),
    ).not.toBe(baseline);
  });

  it("partitions a shared bubble and replaces stale or manual overlapping boxes", () => {
    const page = createPage();
    const template = page.blocks[0];
    const stale: TranslationBlock = {
      ...template,
      id: "stale-left",
      bbox: { x: 125, y: 225, w: 350, h: 500 },
      renderBbox: { x: 100, y: 175, w: 400, h: 600 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: generatedBubbleLayout(),
    };
    const manual: TranslationBlock = {
      ...template,
      id: "manual-right",
      bbox: { x: 525, y: 225, w: 350, h: 500 },
      renderBbox: { x: 510, y: 210, w: 380, h: 530 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: undefined,
    };
    page.blocks = [stale, manual];

    const patches = processDetectedBubbleLayouts({
      page,
      bitmap: createBitmap(240),
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [5, 10, 115, 72], 0.97),
        detection(1, [16, 20, 104, 60], 0.98),
      ],
      policy: "balanced",
      pageRevision: "page-revision",
    });

    expect(patches).toHaveLength(2);
    const left = patchBoundsInPixels(patches[0]);
    const right = patchBoundsInPixels(patches[1]);
    expect(right.x - (left.x + left.w)).toBeGreaterThanOrEqual(3);
    expect(intersectionArea(left, right)).toBe(0);
    expect(patches.map((patch) => patch.bubbleLayout?.direction)).toEqual([
      "horizontal",
      "horizontal",
    ]);
    expect(page.blocks.map((block) => block.bbox)).toEqual([
      stale.bbox,
      manual.bbox,
    ]);
  });

  it("joins stacked shared-bubble masks only for the zero-gap inpaint prepass", () => {
    const buildSharedBubbleMask = (sharedOwnershipGapPx?: number) => {
      const page = createPage();
      const template = page.blocks[0];
      page.blocks = [
        {
          ...template,
          id: "top",
          bbox: { x: 225, y: 125, w: 500, h: 350 },
        },
        {
          ...template,
          id: "bottom",
          bbox: { x: 225, y: 525, w: 500, h: 350 },
        },
      ];
      const patches = processDetectedBubbleLayouts({
        page,
        bitmap: createBitmap(240),
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        detections: [
          detection(0, [5, 5, 115, 75], 0.98),
          detection(1, [16, 14, 104, 66], 0.98),
        ],
        policy: "balanced",
        paddingRatio: 0,
        sharedOwnershipGapPx,
        pageRevision: "page-revision",
      });
      applyLayoutPatches(page, patches);
      const sharedInpaintGroupIdsByBlock = Object.fromEntries(
        patches.flatMap((patch) =>
          patch.sharedInpaintGroupIds?.length
            ? [[patch.blockId, patch.sharedInpaintGroupIds]]
            : [],
        ),
      );
      const context = buildPatternPageMask({
        page,
        bitmap: Buffer.alloc(WIDTH * HEIGHT * 4, 255),
        width: WIDTH,
        height: HEIGHT,
        mode: "flux-region",
        bubbleLayoutConstraintBlockIds: page.blocks.map((block) => block.id),
        sharedInpaintGroupIdsByBlock,
      });
      return {
        context,
        ownedMasks: context.inpaintWindowMasks.map((mask) =>
          expandWindowMaskToPage(mask, WIDTH, HEIGHT),
        ),
      };
    };

    const finalLayout = buildSharedBubbleMask();
    const inpaintPrepass = buildSharedBubbleMask(0);
    const centerX = WIDTH / 2;

    expect(finalLayout.context.blocksErased).toBe(2);
    expect(inpaintPrepass.context.blocksErased).toBe(2);
    expect(finalLayout.ownedMasks).toHaveLength(2);
    expect(inpaintPrepass.ownedMasks).toHaveLength(1);
    expect(inpaintPrepass.context.inpaintWindows).toHaveLength(1);
    expect(inpaintPrepass.context.inpaintWindowConstraints).toHaveLength(1);
    expect(
      countUnmaskedRowsBetweenOwners(finalLayout.ownedMasks, centerX),
    ).toBeGreaterThanOrEqual(3);

    const activeRows = activeRowsAtX(inpaintPrepass.context.pageMask, centerX);
    const firstActiveRow = activeRows[0];
    const lastActiveRow = activeRows.at(-1);
    if (firstActiveRow === undefined || lastActiveRow === undefined) {
      throw new Error("expected a non-empty shared-bubble inpaint mask");
    }
    for (let y = firstActiveRow; y <= lastActiveRow; y += 1) {
      expect(inpaintPrepass.context.pageMask[y * WIDTH + centerX]).toBe(1);
    }
  });

  it("keeps three OCR blocks in one detected balloon pairwise disjoint", () => {
    const page = createPage();
    const template = page.blocks[0];
    page.blocks = [
      {
        ...template,
        id: "left",
        bbox: { x: 100, y: 250, w: 250, h: 500 },
      },
      {
        ...template,
        id: "middle",
        bbox: { x: 330, y: 230, w: 340, h: 540 },
      },
      {
        ...template,
        id: "right",
        bbox: { x: 650, y: 250, w: 250, h: 500 },
      },
    ];

    const patches = processDetectedBubbleLayouts({
      page,
      bitmap: createBitmap(240),
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [4, 8, 116, 74], 0.98),
        detection(1, [12, 18, 108, 64], 0.98),
      ],
      policy: "balanced",
      pageRevision: "page-revision",
    });

    expect(patches).toHaveLength(3);
    const bounds = patches.map(patchBoundsInPixels);
    for (let leftIndex = 0; leftIndex < bounds.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < bounds.length;
        rightIndex += 1
      ) {
        expect(intersectionArea(bounds[leftIndex], bounds[rightIndex])).toBe(0);
      }
    }
    expect(bounds[1].x - (bounds[0].x + bounds[0].w)).toBeGreaterThanOrEqual(3);
    expect(bounds[2].x - (bounds[1].x + bounds[1].w)).toBeGreaterThanOrEqual(3);
  });

  it("preserves separately detected connected-lobe contours without a global cut", () => {
    const page = createPage();
    const template = page.blocks[0];
    page.blocks = [
      {
        ...template,
        id: "left-lobe",
        bbox: { x: 83, y: 250, w: 292, h: 500 },
      },
      {
        ...template,
        id: "right-lobe",
        bbox: { x: 625, y: 188, w: 250, h: 438 },
      },
    ];

    const patches = processDetectedBubbleLayouts({
      page,
      bitmap: createBitmap(240),
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [5, 10, 72, 75], 0.97),
        detection(0, [55, 5, 115, 68], 0.96),
        detection(1, [15, 20, 45, 60], 0.98),
        detection(1, [75, 15, 105, 50], 0.98),
      ],
      policy: "maximize",
      paddingRatio: 0,
      pageRevision: "page-revision",
      repairOriginalTextInk: true,
    });

    expect(patches).toHaveLength(2);
    const [left, right] = patches.map(patchBoundsInPixels);
    expect(intersectionArea(left, right)).toBeGreaterThan(0);
    expect(patches.map((patch) => patch.bubbleLayout?.regions.length)).toEqual([
      1, 1,
    ]);
  });

  it("keeps a multi-candidate owner without overlapping a competing block's shape", () => {
    const page = createPage();
    const template = page.blocks[0];
    page.blocks = [
      {
        ...template,
        id: "wide-owner",
        bbox: { x: 0, y: 250, w: 917, h: 500 },
      },
      {
        ...template,
        id: "nested-owner",
        bbox: { x: 458, y: 250, w: 167, h: 500 },
      },
    ];
    const bitmap = createBitmap(25);
    paintEllipse(bitmap, 45, 40, 34, 29, 245);
    paintEllipse(bitmap, 100, 40, 14, 29, 245);

    const patches = processDetectedBubbleLayouts({
      page,
      bitmap,
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [10, 10, 80, 70], 0.98),
        detection(0, [85, 10, 115, 70], 0.97),
        detection(1, [18, 22, 72, 58], 0.98),
        detection(1, [88, 22, 110, 58], 0.98),
      ],
      policy: "maximize",
      pageRevision: "page-revision",
    });

    expect(patches).toHaveLength(2);
    expect(patches.map((patch) => patch.blockId)).toEqual([
      "wide-owner",
      "nested-owner",
    ]);
    expectPatchShapesDisjoint(patches[0], patches[1]);
  });

  it("partitions pixel-space OCR boxes against resized detector geometry", () => {
    const page = createPage();
    const template = page.blocks[0];
    page.width = WIDTH * 2;
    page.height = HEIGHT * 2;
    page.blocks = [
      {
        ...template,
        id: "pixel-left",
        bbox: { x: 0, y: 30, w: 100, h: 100 },
        bboxSpace: "pixels",
      },
      {
        ...template,
        id: "pixel-right",
        bbox: { x: 140, y: 30, w: 100, h: 100 },
        bboxSpace: "pixels",
      },
    ];

    const patches = processDetectedBubbleLayouts({
      page,
      bitmap: createBitmap(240),
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      detections: [
        detection(0, [0, 0, WIDTH, HEIGHT], 0.98),
        detection(1, [10, 10, 110, 70], 0.98),
      ],
      policy: "balanced",
      pageRevision: "page-revision",
    });

    expect(patches).toHaveLength(2);
    const [left, right] = patches.map(patchBoundsInPixels);
    expect(intersectionArea(left, right)).toBe(0);
    expect(right.x - (left.x + left.w)).toBeGreaterThanOrEqual(3);
  });
});

function patchBoundsInPixels(
  patch: ReturnType<typeof processDetectedBubbleLayouts>[number],
): { x: number; y: number; w: number; h: number } {
  const bbox = patch.renderBbox;
  if (!bbox) throw new Error(`renderBbox가 없습니다: ${patch.blockId}`);
  return {
    x: (bbox.x / 1000) * WIDTH,
    y: (bbox.y / 1000) * HEIGHT,
    w: (bbox.w / 1000) * WIDTH,
    h: (bbox.h / 1000) * HEIGHT,
  };
}

function expectPatchShapesDisjoint(
  leftPatch: ReturnType<typeof processDetectedBubbleLayouts>[number],
  rightPatch: ReturnType<typeof processDetectedBubbleLayouts>[number],
): void {
  const leftRects = patchShapeRectsInPixels(leftPatch);
  const rightRects = patchShapeRectsInPixels(rightPatch);
  expect(leftRects.length).toBeGreaterThan(0);
  expect(rightRects.length).toBeGreaterThan(0);
  for (const left of leftRects) {
    for (const right of rightRects) {
      // Span quantization can leave a sub-pixel-scale overlap even though the
      // underlying ownership masks are disjoint.
      expect(intersectionArea(left, right)).toBeLessThanOrEqual(4);
    }
  }
}

function patchShapeRectsInPixels(
  patch: ReturnType<typeof processDetectedBubbleLayouts>[number],
): { x: number; y: number; w: number; h: number }[] {
  const bounds = patchBoundsInPixels(patch);
  const layout = patch.bubbleLayout;
  if (!layout) throw new Error(`bubbleLayout이 없습니다: ${patch.blockId}`);
  return layout.regions.flatMap((region) =>
    region.spans.map((span) =>
      layout.direction === "horizontal"
        ? {
            x: bounds.x + span.inlineStart * bounds.w,
            y: bounds.y + span.blockStart * bounds.h,
            w: (span.inlineEnd - span.inlineStart) * bounds.w,
            h: (span.blockEnd - span.blockStart) * bounds.h,
          }
        : {
            x: bounds.x + span.blockStart * bounds.w,
            y: bounds.y + span.inlineStart * bounds.h,
            w: (span.blockEnd - span.blockStart) * bounds.w,
            h: (span.inlineEnd - span.inlineStart) * bounds.h,
          },
    ),
  );
}

function intersectionArea(
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number },
): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y),
  );
  return width * height;
}

function applyLayoutPatches(
  page: MangaPage,
  patches: ReturnType<typeof processDetectedBubbleLayouts>,
): void {
  const patchesByBlock = new Map(
    patches.map((patch) => [patch.blockId, patch]),
  );
  page.blocks = page.blocks.map((block) => {
    const patch = patchesByBlock.get(block.id);
    if (!patch?.renderBbox || !patch.renderBboxSpace || !patch.bubbleLayout) {
      return block;
    }
    return {
      ...block,
      renderBbox: patch.renderBbox,
      renderBboxSpace: patch.renderBboxSpace,
      bubbleLayout: patch.bubbleLayout,
    };
  });
}

function countUnmaskedRowsBetweenOwners(
  ownedMasks: Uint8Array[],
  x: number,
): number {
  const topRows = activeRowsAtX(ownedMasks[0] ?? new Uint8Array(), x);
  const bottomRows = activeRowsAtX(ownedMasks[1] ?? new Uint8Array(), x);
  const topEnd = topRows.at(-1);
  const bottomStart = bottomRows[0];
  if (topEnd === undefined || bottomStart === undefined) {
    throw new Error("expected both shared-bubble owner masks");
  }
  return Math.max(0, bottomStart - topEnd - 1);
}

function activeRowsAtX(mask: Uint8Array, x: number): number[] {
  const rows: number[] = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    if (mask[y * WIDTH + x]) rows.push(y);
  }
  return rows;
}

function createPage(): MangaPage {
  return {
    id: "page",
    name: "page.png",
    imagePath: "original.png",
    inpaintedImagePath: "clean.png",
    dataUrl: "",
    width: WIDTH,
    height: HEIGHT,
    blocks: [
      {
        id: "merged",
        type: "nonsolid",
        bbox: { x: 150, y: 225, w: 700, h: 450 },
        bboxSpace: "normalized_1000",
        sourceText: "右 左",
        translatedText: "오른쪽 말풍선 왼쪽 말풍선",
        confidence: 1,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 18,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#000000",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: "",
    updatedAt: "",
  };
}

function detection(
  labelId: ComicDetectionLabelId,
  box: [number, number, number, number],
  score: number,
): ComicPageDetection {
  const labels = ["bubble", "text_bubble", "text_free"] as const;
  return { labelId, label: labels[labelId], box, score };
}

function generatedBubbleLayout(): NonNullable<
  TranslationBlock["bubbleLayout"]
> {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.9,
    origin: "detected",
    modelId: "comic-rtdetr-stale",
    sourceImageRevision: "stale-revision",
    insetRatio: 0.1,
    regions: [
      {
        spans: [
          {
            blockStart: 0,
            blockEnd: 1,
            inlineStart: 0,
            inlineEnd: 1,
          },
        ],
      },
    ],
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

function paintCircle(
  bitmap: Uint8Array,
  centerX: number,
  centerY: number,
  radius: number,
  value: number,
): void {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (Math.hypot(x - centerX, y - centerY) <= radius) {
        const index = (y * WIDTH + x) * 4;
        bitmap[index] = value;
        bitmap[index + 1] = value;
        bitmap[index + 2] = value;
      }
    }
  }
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
      const normalizedX = (x - centerX) / radiusX;
      const normalizedY = (y - centerY) / radiusY;
      if (normalizedX ** 2 + normalizedY ** 2 <= 1) {
        const index = (y * WIDTH + x) * 4;
        bitmap[index] = value;
        bitmap[index + 1] = value;
        bitmap[index + 2] = value;
      }
    }
  }
}

function paintRect(
  bitmap: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  value: number,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const index = (row * WIDTH + column) * 4;
      bitmap[index] = value;
      bitmap[index + 1] = value;
      bitmap[index + 2] = value;
    }
  }
}

function filledRegion(bounds: {
  x: number;
  y: number;
  w: number;
  h: number;
}): RefinedBubbleRegion {
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
