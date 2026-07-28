import { describe, expect, it } from "vitest";
import {
  isGeneratedBubbleLayout,
  isManualBubbleLayout,
  isUsableBubbleLayout,
  MAX_BUBBLE_LAYOUT_REGIONS,
  MAX_BUBBLE_REGION_SPANS,
  type BubbleLayout,
} from "../src/shared/bubbleLayout";
import { hashTranslationBlocks } from "../src/shared/blockFingerprint";
import { sanitizeChapterBboxes } from "../src/shared/geometry";
import {
  BubbleLayoutSchema,
  ChapterSnapshotSchema,
  LibraryChapterFileSchema,
  SavePageBlocksRequestSchema,
  TranslationBlockSchema,
} from "../src/shared/ipcSchemas";
import type {
  ChapterSnapshot,
  LibraryChapter,
} from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";
const WORK_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";

const FUSED_BUBBLE_LAYOUT: BubbleLayout = {
  version: 1,
  direction: "horizontal",
  confidence: 0.94,
  origin: "detected",
  modelId: "bubble-shape-v1",
  sourceImageRevision: "sha256:page-revision",
  insetRatio: 0.06,
  regions: [
    {
      spans: [
        {
          blockStart: 0.08,
          blockEnd: 0.28,
          inlineStart: 0.05,
          inlineEnd: 0.46,
        },
        {
          blockStart: 0.28,
          blockEnd: 0.54,
          inlineStart: 0.02,
          inlineEnd: 0.48,
        },
      ],
    },
    {
      // This region deliberately overlaps the first region on the block axis.
      // Separate regions represent two fused balloon lobes in reading order.
      spans: [
        {
          blockStart: 0.1,
          blockEnd: 0.3,
          inlineStart: 0.55,
          inlineEnd: 0.95,
        },
        {
          blockStart: 0.3,
          blockEnd: 0.58,
          inlineStart: 0.52,
          inlineEnd: 0.98,
        },
      ],
    },
  ],
};

describe("bubble-aware block data model", () => {
  it("accepts and preserves a two-region fused balloon in reading order", () => {
    const block = makeBlock();
    const parsed = TranslationBlockSchema.parse(block);

    expect(parsed.bbox).toEqual(block.bbox);
    expect(parsed.renderBbox).toEqual(block.renderBbox);
    expect(parsed.bubbleLayout).toEqual(FUSED_BUBBLE_LAYOUT);
    expect(isUsableBubbleLayout(parsed.bubbleLayout)).toBe(true);
  });

  it("round-trips bubble geometry through strict save and chapter schemas", () => {
    const block = makeBlock();
    const saveRequest = SavePageBlocksRequestSchema.parse({
      chapterId: CHAPTER_ID,
      pageId: PAGE_ID,
      blocks: [block],
    });
    const snapshot = ChapterSnapshotSchema.parse(
      makeSnapshot([saveRequest.blocks[0]]),
    );
    const stored = LibraryChapterFileSchema.parse(
      makeStoredChapter([snapshot.pages[0].blocks[0]]),
    );

    expect(saveRequest.blocks[0].bubbleLayout).toEqual(FUSED_BUBBLE_LAYOUT);
    expect(snapshot.pages[0].blocks[0].bubbleLayout).toEqual(
      FUSED_BUBBLE_LAYOUT,
    );
    expect(stored.pages[0].blocks[0].bubbleLayout).toEqual(FUSED_BUBBLE_LAYOUT);
  });

  it("keeps relative bubble regions while normalizing persisted pixel boxes", () => {
    const block = makeBlock({
      bbox: { x: 100, y: 200, w: 300, h: 400 },
      bboxSpace: "pixels",
      renderBbox: { x: 80, y: 160, w: 360, h: 480 },
      renderBboxSpace: "pixels",
    });
    const chapter = sanitizeChapterBboxes(
      makeSnapshot([block], { width: 1000, height: 2000 }),
    );
    const normalized = chapter.pages[0].blocks[0];

    expect(normalized.bbox).toEqual({ x: 100, y: 100, w: 300, h: 200 });
    expect(normalized.renderBbox).toEqual({
      x: 80,
      y: 80,
      w: 360,
      h: 240,
    });
    expect(normalized.bubbleLayout).toEqual(FUSED_BUBBLE_LAYOUT);
  });

  it("rejects malformed, overlapping, oversized, and non-strict layouts", () => {
    expect(
      BubbleLayoutSchema.safeParse({
        ...FUSED_BUBBLE_LAYOUT,
        regions: [
          {
            spans: [
              {
                blockStart: 0.1,
                blockEnd: 0.6,
                inlineStart: 0.1,
                inlineEnd: 0.9,
              },
              {
                blockStart: 0.5,
                blockEnd: 0.8,
                inlineStart: 0.1,
                inlineEnd: 0.9,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      BubbleLayoutSchema.safeParse({
        ...FUSED_BUBBLE_LAYOUT,
        regions: [
          {
            spans: [
              {
                blockStart: 0.4,
                blockEnd: 0.4,
                inlineStart: 0.1,
                inlineEnd: 1.1,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      BubbleLayoutSchema.safeParse({
        ...FUSED_BUBBLE_LAYOUT,
        regions: Array.from(
          { length: MAX_BUBBLE_LAYOUT_REGIONS + 1 },
          () => FUSED_BUBBLE_LAYOUT.regions[0],
        ),
      }).success,
    ).toBe(false);
    expect(
      BubbleLayoutSchema.safeParse({
        ...FUSED_BUBBLE_LAYOUT,
        regions: [
          {
            spans: Array.from(
              { length: MAX_BUBBLE_REGION_SPANS + 1 },
              (_, index) => ({
                blockStart: index / (MAX_BUBBLE_REGION_SPANS + 1),
                blockEnd: (index + 1) / (MAX_BUBBLE_REGION_SPANS + 1),
                inlineStart: 0.1,
                inlineEnd: 0.9,
              }),
            ),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      BubbleLayoutSchema.safeParse({
        ...FUSED_BUBBLE_LAYOUT,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("uses the same strict invariants in the lightweight runtime guard", () => {
    expect(isUsableBubbleLayout(FUSED_BUBBLE_LAYOUT)).toBe(true);
    expect(
      isUsableBubbleLayout({
        ...FUSED_BUBBLE_LAYOUT,
        confidence: Number.NaN,
      }),
    ).toBe(false);
    expect(
      isUsableBubbleLayout({
        ...FUSED_BUBBLE_LAYOUT,
        regions: [
          {
            spans: [
              {
                blockStart: 0.7,
                blockEnd: 0.8,
                inlineStart: 0.1,
                inlineEnd: 0.9,
              },
              {
                blockStart: 0.2,
                blockEnd: 0.3,
                inlineStart: 0.1,
                inlineEnd: 0.9,
              },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it("distinguishes generated and manual provenance without invalidating legacy data", () => {
    const manual: BubbleLayout = {
      ...FUSED_BUBBLE_LAYOUT,
      origin: "manual",
      modelId: "manual-shape-v1",
      sourceImageRevision: undefined,
    };
    const legacyGenerated: BubbleLayout = {
      ...FUSED_BUBBLE_LAYOUT,
      origin: undefined,
      modelId: "comic-rtdetr-legacy",
    };

    expect(BubbleLayoutSchema.safeParse(manual).success).toBe(true);
    expect(isUsableBubbleLayout(manual)).toBe(true);
    expect(isManualBubbleLayout(manual)).toBe(true);
    expect(isGeneratedBubbleLayout(manual)).toBe(false);
    expect(isGeneratedBubbleLayout(FUSED_BUBBLE_LAYOUT)).toBe(true);
    expect(isGeneratedBubbleLayout(legacyGenerated)).toBe(true);

    const invalidManual = {
      ...manual,
      sourceImageRevision: "must-not-be-stale-cleared",
    };
    expect(BubbleLayoutSchema.safeParse(invalidManual).success).toBe(false);
    expect(isUsableBubbleLayout(invalidManual)).toBe(false);

    const invalidDetected = {
      ...FUSED_BUBBLE_LAYOUT,
      modelId: undefined,
    };
    expect(BubbleLayoutSchema.safeParse(invalidDetected).success).toBe(false);
    expect(isUsableBubbleLayout(invalidDetected)).toBe(false);
  });

  it("includes bubble geometry in block conflict fingerprints", () => {
    const block = makeBlock();
    const changedLayout = {
      ...FUSED_BUBBLE_LAYOUT,
      confidence: 0.8,
    };

    expect(hashTranslationBlocks([block])).not.toBe(
      hashTranslationBlocks([{ ...block, bubbleLayout: changedLayout }]),
    );
  });
});

function makeBlock(
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 220, h: 280 },
    renderBbox: { x: 80, y: 80, w: 260, h: 320 },
    bboxSpace: "normalized_1000",
    renderBboxSpace: "normalized_1000",
    bubbleLayout: FUSED_BUBBLE_LAYOUT,
    sourceText: "source",
    translatedText: "번역문",
    confidence: 0.9,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#fffdf5",
    opacity: 0.8,
    ...overrides,
  };
}

function makeSnapshot(
  blocks: TranslationBlock[],
  pageSize = { width: 1000, height: 1200 },
): ChapterSnapshot {
  const chapter = makeStoredChapter(blocks, pageSize);
  return {
    ...chapter,
    pages: chapter.pages.map((page) => ({ ...page, dataUrl: "" })),
  };
}

function makeStoredChapter(
  blocks: TranslationBlock[],
  pageSize = { width: 1000, height: 1200 },
): LibraryChapter {
  const page = {
    id: PAGE_ID,
    name: "001.png",
    imagePath: "C:\\library\\works\\work\\chapters\\chapter\\pages\\001.png",
    width: pageSize.width,
    height: pageSize.height,
    blocks,
    analysisStatus: "completed" as const,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "1화",
    sourceKind: "folder" as const,
    status: "completed" as const,
    pageOrder: [PAGE_ID],
    pages: [page],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}
