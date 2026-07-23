import { describe, expect, it } from "vitest";
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions inspect dynamic CJS JSON-schema objects */

const fixed =
  require("../src/main/runtime/semantic-ocr/fixed-block-translation.cjs") as {
    buildFixedBlockOverlayPayload: (
      plan: FixedBlockPlan,
      translations: FixedTranslationResult,
    ) => {
      items: Array<Record<string, unknown>>;
      pageContext?: Record<string, unknown>;
    };
    buildFixedBlockPlan: (
      options: Record<string, unknown>,
      variants: Array<Record<string, unknown>>,
    ) => FixedBlockPlan;
    buildFixedBlockTranslationPrompt: (
      plan: FixedBlockPlan,
      options: Record<string, unknown>,
    ) => string;
    parseFixedBlockTranslationResponse: (
      raw: string,
      plan: FixedBlockPlan,
      options?: Record<string, unknown>,
    ) => FixedTranslationResult;
    shouldUseFixedBlockTranslation: (
      options: Record<string, unknown>,
    ) => boolean;
  };

const formats =
  require("../src/main/runtime/semantic-ocr/response-formats.cjs") as {
    buildFixedBlockTranslationResponseFormat: (
      ids: string[],
      options?: Record<string, unknown>,
    ) => Record<string, any>;
  };

type FixedBlock = {
  blockId: string;
  representativeId: number;
  candidateIds: number[];
  jp: string;
  bbox: { x1: number; y1: number; x2: number; y2: number };
  direction: "horizontal" | "vertical";
  confidence: number;
  soundCandidate: boolean;
  fragments: Array<Record<string, unknown>>;
};

type FixedBlockPlan = { version: 4; blocks: FixedBlock[] };
type FixedTranslationResult = {
  items: Array<{ blockId: string; ko: string }>;
  pageContext?: Record<string, unknown>;
};

const baseOptions = {
  modelProvider: "gemma",
  sourceLanguage: "ja",
  targetLanguage: "ko",
  ocrQualityMode: "economy",
  ocrMergeMode: "semantic",
  imageWidth: 1000,
  imageHeight: 1000,
};

const baseVariant = {
  role: "original",
  width: 1000,
  height: 1000,
  originalWidth: 1000,
  originalHeight: 1000,
};

describe("fixed-block translation contract", () => {
  it("freezes one complete semantic group and keeps a singleton separate", () => {
    const plan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [
          semanticHint(1, "後半", 320, 100, 360, 300, 2, 2),
          semanticHint(2, "前半", 380, 90, 420, 290, 1, 2),
          {
            id: 3,
            label: "ocr_textline",
            x1: 100,
            y1: 500,
            x2: 240,
            y2: 550,
            score: 0.94,
            ocrText: "別の台詞",
          },
        ],
      },
      [baseVariant],
    );

    expect(plan.blocks).toHaveLength(2);
    expect(plan.blocks[0]).toMatchObject({
      blockId: "B001",
      representativeId: 1,
      candidateIds: [2, 1],
      jp: "前半後半",
      bbox: { x1: 320, y1: 90, x2: 420, y2: 300 },
    });
    expect(plan.blocks[1]).toMatchObject({
      blockId: "B002",
      representativeId: 3,
      candidateIds: [3],
      jp: "別の台詞",
      bbox: { x1: 100, y1: 500, x2: 240, y2: 550 },
    });
  });

  it("does not merge nearby singletons or an incomplete semantic group", () => {
    const plan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [
          semanticHint(1, "右", 500, 100, 540, 300, 1, 3),
          semanticHint(2, "左", 545, 100, 585, 300, 2, 3),
        ],
      },
      [baseVariant],
    );

    expect(plan.blocks.map((block) => block.candidateIds)).toEqual([[1], [2]]);
  });

  it("keeps the raw OCR source instead of the sanitized candidate text", () => {
    const plan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [
          {
            id: 1,
            label: "ocr_textline",
            x1: 100,
            y1: 100,
            x2: 300,
            y2: 180,
            score: 0.99,
            ocrText: "勇者 Brave Hearts",
          },
        ],
      },
      [baseVariant],
    );

    expect(plan.blocks[0]?.jp).toBe("勇者 Brave Hearts");
  });

  it("keeps ruby geometry in the fixed block without repeating ruby text in jp", () => {
    const body = semanticHint(1, "権限がある", 100, 100, 180, 320, 1, 2);
    const ruby = {
      ...semanticHint(2, "けんげん", 175, 105, 190, 180, 2, 2),
      reviewRole: "ruby",
    };
    const plan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [body, ruby],
      },
      [baseVariant],
    );

    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]).toMatchObject({
      candidateIds: [1, 2],
      jp: "権限がある",
      bbox: { x1: 100, y1: 100, x2: 190, y2: 320 },
    });
  });

  it("uses opaque block ids and exposes no output geometry fields", () => {
    const responseFormat = formats.buildFixedBlockTranslationResponseFormat([
      "B001",
      "B002",
    ]);
    const itemSchema = responseFormat.schema.properties.items.items as Record<
      string,
      any
    >;
    expect(itemSchema.additionalProperties).toBe(false);
    expect(Object.keys(itemSchema.properties)).toEqual(["blockId", "ko"]);
    expect(itemSchema.properties.blockId.enum).toEqual(["B001", "B002"]);
    expect(itemSchema.properties.ko.pattern).not.toContain("*");
  });

  it("rejects the old page-17 style response that creates ids and coordinates", () => {
    const plan = page17Plan();
    const oldResponse = JSON.stringify({
      items: [
        {
          id: 13,
          x1: 701,
          y1: 325,
          x2: 848,
          y2: 577,
          jp: "存じて\nおりますん！",
          ko: "알고 있습니다!",
        },
        {
          id: 14,
          x1: 773,
          y1: 325,
          x2: 848,
          y2: 459,
          jp: "存じて",
          ko: "알고",
        },
      ],
    });

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(oldResponse, plan),
    ).toThrow(/forbidden fields/i);
  });

  it("requires the exact block-id partition without content-based reassignment", () => {
    const plan = twoSingletonPlan();
    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "오른쪽" },
            { blockId: "B001", ko: "왼쪽" },
          ],
        }),
        plan,
      ),
    ).toThrow(/duplicate=\[B001\].*missing=\[B002\]/i);

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "오른쪽" },
            { blockId: "B999", ko: "왼쪽" },
          ],
        }),
        plan,
      ),
    ).toThrow(/unexpected=\[B999\].*missing=\[B002\]/i);

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B002", ko: "왼쪽" },
            { blockId: "B001", ko: "오른쪽" },
          ],
        }),
        plan,
      ),
    ).toThrow(/order failed.*expected=\[B001,B002\].*actual=\[B002,B001\]/i);
  });

  it("synthesizes the page-17 candidate ownership and union bbox in code", () => {
    const plan = page17Plan();
    const translations = fixed.parseFixedBlockTranslationResponse(
      JSON.stringify({
        items: [
          {
            blockId: "B001",
            ko: "알고 있습니다!",
          },
        ],
      }),
      plan,
    );
    const payload = fixed.buildFixedBlockOverlayPayload(plan, translations);

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      id: 13,
      candidateIds: [14, 13],
      x1: 701,
      y1: 325,
      x2: 848,
      y2: 577,
      jp: "存じておりますん！",
      ko: "알고 있습니다!",
    });
  });

  it("preserves every finalized block and rejects attempts to rewrite source fields", () => {
    const plan = twoSingletonPlan();
    const translations = fixed.parseFixedBlockTranslationResponse(
      JSON.stringify({
        items: [
          { blockId: "B001", ko: "오른쪽" },
          { blockId: "B002", ko: "왼쪽" },
        ],
      }),
      plan,
    );
    expect(
      fixed.buildFixedBlockOverlayPayload(plan, translations).items,
    ).toHaveLength(2);

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "오른쪽" },
            { blockId: "B002", ko: "" },
          ],
        }),
        plan,
      ),
    ).toThrow(/non-empty ko/i);

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "오른쪽" },
            { blockId: "B002", jp: "左", ko: "왼쪽" },
          ],
        }),
        plan,
      ),
    ).toThrow(/forbidden fields.*jp/i);
  });

  it("retains a code-approved sound block without asking the translator to classify it", () => {
    const plan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [
          {
            id: 8,
            label: "ocr_sfx",
            x1: 100,
            y1: 100,
            x2: 220,
            y2: 300,
            score: 0.42,
            ocrText: "ドン",
          },
        ],
      },
      [baseVariant],
    );
    const translations = fixed.parseFixedBlockTranslationResponse(
      JSON.stringify({ items: [{ blockId: "B001", ko: "쾅" }] }),
      plan,
    );

    expect(
      fixed.buildFixedBlockOverlayPayload(plan, translations).items[0],
    ).toMatchObject({
      textRole: "sound",
      confidence: 1,
      jp: "ドン",
      ko: "쾅",
    });
  });

  it("allows pageContext only when requested and keeps it outside block items", () => {
    const plan = twoSingletonPlan();
    const pageContext = {
      visualSummary: "두 사람이 대화한다.",
      glossary: [],
      characters: [],
    };
    const raw = JSON.stringify({
      items: [
        { blockId: "B001", ko: "오른쪽" },
        { blockId: "B002", ko: "왼쪽" },
      ],
      pageContext,
    });

    expect(() => fixed.parseFixedBlockTranslationResponse(raw, plan)).toThrow(
      /forbidden top-level fields.*pageContext/i,
    );
    const parsed = fixed.parseFixedBlockTranslationResponse(raw, plan, {
      collectPageContext: true,
    });
    expect(parsed.pageContext).toEqual(pageContext);
    expect(
      fixed.buildFixedBlockOverlayPayload(plan, parsed).pageContext,
    ).toEqual(pageContext);

    const responseFormat = formats.buildFixedBlockTranslationResponseFormat(
      ["B001", "B002"],
      { collectPageContext: true },
    );
    expect(responseFormat.schema.properties).toHaveProperty("pageContext");
    expect(responseFormat.schema.properties.items.items.properties).toEqual(
      expect.objectContaining({
        blockId: expect.any(Object),
        ko: expect.any(Object),
      }),
    );
  });

  it("uses the final path only after the intended common Gemma mode has a validated review", () => {
    const options = {
      ...baseOptions,
      validatedGroupOnlyReview: true,
      ocrBboxHints: [
        {
          id: 1,
          x1: 0,
          y1: 0,
          x2: 10,
          y2: 10,
          ocrText: "本文",
          reviewFragmentId: "B001",
          reviewStatus: "confirmed",
        },
      ],
    };
    expect(fixed.shouldUseFixedBlockTranslation(options)).toBe(true);
    expect(
      fixed.shouldUseFixedBlockTranslation({
        ...options,
        validatedGroupOnlyReview: false,
      }),
    ).toBe(false);
    for (const excluded of [
      { modelProvider: "openai" },
      { ocrQualityMode: "cuda-legacy-full" },
      { regionCropMode: true },
      { keepBlocksMode: true },
      { promptOverrideText: "custom" },
      { sourceLanguage: "en" },
      { ocrBboxHints: [] },
    ]) {
      expect(
        fixed.shouldUseFixedBlockTranslation({ ...options, ...excluded }),
      ).toBe(false);
    }
  });

  it("states that grouping and coordinates are immutable", () => {
    const prompt = fixed.buildFixedBlockTranslationPrompt(
      twoSingletonPlan(),
      baseOptions,
    );
    expect(prompt).toContain(
      "Every blockId, jp, direction, bbox, block count, and block order was already fixed before translation",
    );
    expect(prompt).toContain("Each item has exactly two keys: blockId and ko");
    expect(prompt).toContain("fixedBlocks=");
    const payload = JSON.parse(
      prompt.split("fixedBlocks=")[1] ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(Object.keys(payload[0] ?? {})).toEqual([
      "blockId",
      "jp",
      "direction",
      "bbox",
    ]);
  });
});

function semanticHint(
  id: number,
  text: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  orderInGroup: number,
  groupSize: number,
) {
  return {
    id,
    label: "ocr_textline",
    x1,
    y1,
    x2,
    y2,
    score: 0.95,
    ocrText: text,
    groupId: "G001",
    orderInGroup,
    groupSize,
    rolePrior: "ordinary_mergeable",
    containerType: "same_text_container",
    semanticGroup: true,
  };
}

function page17Plan(): FixedBlockPlan {
  return fixed.buildFixedBlockPlan(
    {
      ...baseOptions,
      imageWidth: 960,
      imageHeight: 1365,
      ocrBboxHints: [
        semanticHint(13, "おりますん！", 673, 443, 746, 788, 2, 2),
        semanticHint(14, "存じて", 742, 444, 814, 626, 1, 2),
      ],
    },
    [
      {
        role: "original",
        width: 960,
        height: 1365,
        originalWidth: 960,
        originalHeight: 1365,
      },
    ],
  );
}

function twoSingletonPlan(): FixedBlockPlan {
  return fixed.buildFixedBlockPlan(
    {
      ...baseOptions,
      ocrBboxHints: [
        {
          id: 1,
          x1: 600,
          y1: 100,
          x2: 650,
          y2: 300,
          ocrText: "右",
          score: 0.9,
        },
        {
          id: 2,
          x1: 530,
          y1: 100,
          x2: 580,
          y2: 300,
          ocrText: "左",
          score: 0.9,
        },
      ],
    },
    [baseVariant],
  );
}
