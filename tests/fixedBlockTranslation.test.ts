import { describe, expect, it } from "vitest";

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
    parseFixedBlockTranslationDraft: (
      raw: string,
      plan: FixedBlockPlan,
      options?: Record<string, unknown>,
    ) => FixedTranslationResult;
    parseFixedBlockTranslationPartialResponse: (
      raw: string,
      plan: FixedBlockPlan,
      options?: Record<string, unknown>,
    ) => {
      translations: FixedTranslationResult;
      retryBlockIds: string[];
    };
    mergeFixedBlockTranslationResults: (
      current: FixedTranslationResult,
      repaired: FixedTranslationResult,
      expectedIds?: string[],
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
    ) => FixedBlockResponseFormat;
  };

type FixedBlockResponseFormat = {
  schema: {
    properties: {
      items: {
        items: {
          additionalProperties: boolean;
          properties: {
            blockId: { enum: string[] };
            textRole: { enum: string[] };
            fontRole?: { enum: string[] };
            fontRoleConfidence?: { minimum: number; maximum: number };
            visualClusterId?: { type: string; maxLength?: number };
            ko: { pattern: string };
          };
          required: string[];
        };
      };
      pageContext?: unknown;
    };
  };
};

type FixedBlock = {
  blockId: string;
  representativeId: number;
  candidateIds: number[];
  directionVoterCandidateIds: number[];
  jp: string;
  bbox: { x1: number; y1: number; x2: number; y2: number };
  direction: "horizontal" | "vertical";
  confidence: number;
  soundCandidate: boolean;
  fragments: Array<Record<string, unknown>>;
};

type FixedBlockPlan = { version: 5; blocks: FixedBlock[] };
type FixedTranslationResult = {
  items: Array<{
    blockId: string;
    textRole?: "ordinary" | "sound";
    fontRole?: string;
    fontRoleConfidence?: number;
    visualClusterId?: string;
    ko: string;
  }>;
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
      directionVoterCandidateIds: [1],
      jp: "権限がある",
      bbox: { x1: 100, y1: 100, x2: 190, y2: 320 },
    });
  });

  it("derives source direction from body rows instead of ruby geometry", () => {
    const verticalBody = semanticHint(1, "本文", 100, 100, 140, 300, 1, 3);
    const horizontalRuby = [
      {
        ...semanticHint(2, "ほん", 145, 120, 220, 135, 2, 3),
        reviewRole: "ruby",
      },
      {
        ...semanticHint(3, "ぶん", 145, 150, 220, 165, 3, 3),
        reviewRole: "ruby",
      },
    ];
    const horizontalBody = semanticHint(4, "横書き", 300, 100, 500, 140, 1, 3);
    const verticalRuby = [
      {
        ...semanticHint(5, "よこ", 305, 145, 320, 220, 2, 3),
        reviewRole: "ruby",
      },
      {
        ...semanticHint(6, "がき", 330, 145, 345, 220, 3, 3),
        reviewRole: "ruby",
      },
    ];
    for (const hint of [horizontalBody, ...verticalRuby]) {
      hint.groupId = "G002";
    }
    const plan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [
          verticalBody,
          ...horizontalRuby,
          horizontalBody,
          ...verticalRuby,
        ],
      },
      [baseVariant],
    );

    expect(plan.blocks.map((block) => block.direction)).toEqual([
      "vertical",
      "horizontal",
    ]);
  });

  it("drops only final groups made entirely from explicit deferred low-confidence noise", () => {
    const lowSingleton = {
      id: 2,
      label: "ocr_textline",
      x1: 200,
      y1: 100,
      x2: 220,
      y2: 120,
      score: 0.44,
      ocrText: "丽",
      reviewStatus: "deferred",
      reviewReasons: ["dense_page_single_glyph"],
    };
    const lowGroup = [
      {
        ...lowSingleton,
        id: 3,
        y1: 200,
        y2: 230,
        score: 0.34,
        ocrText: "龍",
        groupId: "G002",
        orderInGroup: 1,
        groupSize: 2,
        semanticGroup: true,
      },
      {
        ...lowSingleton,
        id: 4,
        y1: 235,
        y2: 260,
        score: 0.21,
        ocrText: "的",
        reviewReasons: ["small_low_confidence_text"],
        groupId: "G002",
        orderInGroup: 2,
        groupSize: 2,
        semanticGroup: true,
      },
    ];
    const unclassifiedLow = {
      id: 5,
      label: "ocr_textline",
      x1: 300,
      y1: 100,
      x2: 340,
      y2: 180,
      score: 0.3,
      ocrText: "実文",
    };
    const mixedGroup = [
      {
        ...semanticHint(6, "本文", 400, 100, 440, 260, 1, 2),
        groupId: "G003",
      },
      {
        ...lowSingleton,
        id: 7,
        x1: 430,
        x2: 440,
        y1: 130,
        y2: 155,
        score: 0.3,
        ocrText: "ほん",
        reviewReasons: ["small_low_confidence_text"],
        groupId: "G003",
        orderInGroup: 2,
        groupSize: 2,
        semanticGroup: true,
        rolePrior: "ordinary_mergeable",
        containerType: "same_text_container",
        reviewRole: "ruby",
      },
    ];
    const upstreamRejectedSfx = {
      ...lowSingleton,
      id: 8,
      x1: 500,
      x2: 570,
      score: 0.85,
      ocrText: "ド",
      reviewReasons: ["oversized_uncertain_sfx"],
    };
    const plan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [
          { ...unclassifiedLow, id: 1, score: 0.99, ocrText: "正常" },
          lowSingleton,
          ...lowGroup,
          unclassifiedLow,
          ...mixedGroup,
          upstreamRejectedSfx,
        ],
      },
      [baseVariant],
    );

    expect(plan.blocks.map((block) => block.candidateIds)).toEqual([
      [1],
      [5],
      [6, 7],
    ]);
  });

  it("uses opaque block ids and exposes no output geometry fields", () => {
    const responseFormat = formats.buildFixedBlockTranslationResponseFormat([
      "B001",
      "B002",
    ]);
    const itemSchema = responseFormat.schema.properties.items.items;
    expect(itemSchema.additionalProperties).toBe(false);
    expect(Object.keys(itemSchema.properties)).toEqual([
      "blockId",
      "textRole",
      "ko",
    ]);
    expect(itemSchema.properties.blockId.enum).toEqual(["B001", "B002"]);
    expect(itemSchema.properties.textRole.enum).toEqual(["ordinary", "sound"]);
    expect(itemSchema.properties.ko.pattern).not.toContain("*");
  });

  it("adds only the V2 visual-role fields when automatic matching is enabled", () => {
    const responseFormat = formats.buildFixedBlockTranslationResponseFormat(
      ["B001"],
      { autoFontMatching: true },
    );
    const itemSchema = responseFormat.schema.properties.items.items;

    expect(Object.keys(itemSchema.properties)).toEqual([
      "blockId",
      "textRole",
      "fontRole",
      "fontRoleConfidence",
      "visualClusterId",
      "ko",
    ]);
    expect(itemSchema.properties.fontRole?.enum).toContain("sfx_impact");
    expect(itemSchema.properties.fontRoleConfidence).toEqual({
      type: "number",
      minimum: 0,
      maximum: 1,
    });
    expect(itemSchema.properties.visualClusterId).toEqual({ type: "string" });
    expect(itemSchema.required).not.toContain("visualClusterId");
    expect(itemSchema.properties).not.toHaveProperty("visual_cluster_id");
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

  it("rejects untranslated Japanese script in Korean output but allows target-safe text", () => {
    const plan = twoSingletonPlan();
    for (const leaked of ["俺", "원작에서는 瘴気の 항체약", "하ー"]) {
      expect(() =>
        fixed.parseFixedBlockTranslationResponse(
          JSON.stringify({
            items: [
              { blockId: "B001", ko: leaked },
              { blockId: "B002", ko: "왼쪽" },
            ],
          }),
          plan,
          baseOptions,
        ),
      ).toThrow(/untranslated Japanese script/i);
    }
    expect(
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "Brave Hearts 7" },
            { blockId: "B002", ko: "쾅!" },
          ],
        }),
        plan,
        baseOptions,
      ).items,
    ).toHaveLength(2);
    expect(
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "右边" },
            { blockId: "B002", ko: "左边" },
          ],
        }),
        plan,
        { ...baseOptions, targetLanguage: "zh-Hans" },
      ).items,
    ).toHaveLength(2);
    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "右边" },
            { blockId: "B002", ko: "왼쪽" },
          ],
        }),
        plan,
        { ...baseOptions, sourceLanguage: "zh", targetLanguage: "ko" },
      ),
    ).toThrow(/untranslated Simplified Chinese script/i);
    expect(
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "右辺" },
            { blockId: "B002", ko: "左辺" },
          ],
        }),
        plan,
        { ...baseOptions, sourceLanguage: "zh", targetLanguage: "ja" },
      ).items,
    ).toHaveLength(2);
    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", ko: "오른쪽" },
            { blockId: "B002", ko: "left" },
          ],
        }),
        plan,
        { ...baseOptions, sourceLanguage: "ko", targetLanguage: "en" },
      ),
    ).toThrow(/untranslated Korean script/i);
  });

  it("preserves valid blocks and page context while replacing only repaired translations", () => {
    const plan = twoSingletonPlan();
    const draft = fixed.parseFixedBlockTranslationDraft(
      JSON.stringify({
        items: [
          { blockId: "B001", ko: "俺" },
          { blockId: "B002", ko: "정상 번역" },
        ],
        pageContext: { visualSummary: "장면" },
      }),
      plan,
      { ...baseOptions, collectPageContext: true },
    );
    const merged = fixed.mergeFixedBlockTranslationResults(draft, {
      items: [{ blockId: "B001", ko: "나" }],
    });

    expect(merged).toEqual({
      items: [
        { blockId: "B001", ko: "나" },
        { blockId: "B002", ko: "정상 번역" },
      ],
      pageContext: { visualSummary: "장면" },
    });
    expect(
      fixed.parseFixedBlockTranslationResponse(JSON.stringify(merged), plan, {
        ...baseOptions,
        collectPageContext: true,
      }),
    ).toEqual(merged);
  });

  it("salvages only unique contract-valid expected ids from a readable items array", () => {
    const plan = threeSingletonPlan();
    const partial = fixed.parseFixedBlockTranslationPartialResponse(
      JSON.stringify({
        items: [
          { blockId: "B002", ko: "둘째" },
          { blockId: "B001", ko: "첫째" },
          { blockId: "B001", ko: "중복" },
          { blockId: "B003", ko: "俺" },
          { blockId: "B999", ko: "예상하지 않은 항목" },
          null,
        ],
        pageContext: { visualSummary: "유효한 장면 정보" },
        commentary: "금지된 최상위 필드는 복구 과정에서 무시한다.",
      }),
      plan,
      { ...baseOptions, collectPageContext: true },
    );

    expect(partial).toEqual({
      translations: {
        items: [{ blockId: "B002", ko: "둘째" }],
        pageContext: { visualSummary: "유효한 장면 정보" },
      },
      retryBlockIds: ["B001", "B003"],
    });
  });

  it("inserts recovered missing blocks in immutable plan order without regenerating valid ones", () => {
    const plan = threeSingletonPlan();
    const initial = fixed.parseFixedBlockTranslationPartialResponse(
      JSON.stringify({
        items: [
          { blockId: "B002", ko: "보존할 둘째" },
          { blockId: "B001", ko: "" },
        ],
        pageContext: { visualSummary: "보존할 장면" },
      }),
      plan,
      { ...baseOptions, collectPageContext: true },
    );
    const repairPlan = {
      ...plan,
      blocks: plan.blocks.filter((block) =>
        initial.retryBlockIds.includes(block.blockId),
      ),
    };
    const repaired = fixed.parseFixedBlockTranslationPartialResponse(
      JSON.stringify({
        items: [
          { blockId: "B003", ko: "셋째" },
          { blockId: "B001", ko: "첫째" },
        ],
      }),
      repairPlan,
      baseOptions,
    );
    const merged = fixed.mergeFixedBlockTranslationResults(
      initial.translations,
      repaired.translations,
      plan.blocks.map((block) => block.blockId),
    );

    expect(repaired.retryBlockIds).toEqual([]);
    expect(merged).toEqual({
      items: [
        { blockId: "B001", ko: "첫째" },
        { blockId: "B002", ko: "보존할 둘째" },
        { blockId: "B003", ko: "셋째" },
      ],
      pageContext: { visualSummary: "보존할 장면" },
    });
  });

  it("still rejects an unreadable whole response instead of guessing block ownership", () => {
    const plan = twoSingletonPlan();
    expect(() =>
      fixed.parseFixedBlockTranslationPartialResponse("{not-json", plan),
    ).toThrow(/valid JSON/i);
    expect(() =>
      fixed.parseFixedBlockTranslationPartialResponse(
        JSON.stringify({ items: "not-an-array" }),
        plan,
      ),
    ).toThrow(/items array/i);
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

  it("approves only high-confidence code-classified sound blocks", () => {
    const buildSoundPlan = (score: number) =>
      fixed.buildFixedBlockPlan(
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
              score,
              ocrText: "ドン",
            },
          ],
        },
        [baseVariant],
      );
    const translate = (plan: FixedBlockPlan) =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({ items: [{ blockId: "B001", ko: "쾅" }] }),
        plan,
      );
    const lowPlan = buildSoundPlan(0.42);
    const highPlan = buildSoundPlan(0.95);
    expect(
      fixed.buildFixedBlockOverlayPayload(lowPlan, translate(lowPlan)).items[0],
    ).toMatchObject({
      textRole: "sound",
      confidence: 0.42,
      jp: "ドン",
      ko: "쾅",
    });
    expect(
      fixed.buildFixedBlockOverlayPayload(highPlan, translate(highPlan))
        .items[0],
    ).toMatchObject({ textRole: "sound", confidence: 1 });

    const splitSoundPlan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [
          {
            id: 9,
            label: "ocr_sfx",
            x1: 100,
            y1: 100,
            x2: 160,
            y2: 300,
            score: 0.42,
            ocrText: "ド",
            groupId: "G001",
            orderInGroup: 1,
            groupSize: 2,
            rolePrior: "ordinary_mergeable",
            containerType: "same_text_container",
            semanticGroup: true,
          },
          {
            id: 10,
            label: "ocr_sfx",
            x1: 160,
            y1: 100,
            x2: 220,
            y2: 300,
            score: 0.44,
            ocrText: "ン",
            groupId: "G001",
            orderInGroup: 2,
            groupSize: 2,
            rolePrior: "ordinary_mergeable",
            containerType: "same_text_container",
            semanticGroup: true,
          },
        ],
      },
      [baseVariant],
    );
    expect(splitSoundPlan.blocks).toHaveLength(1);
    expect(
      fixed.buildFixedBlockOverlayPayload(
        splitSoundPlan,
        translate(splitSoundPlan),
      ).items[0],
    ).toMatchObject({ textRole: "sound", confidence: 0.43 });
  });

  it("uses Gemma's image-grounded role without changing code-owned geometry", () => {
    const plan = fixed.buildFixedBlockPlan(
      {
        ...baseOptions,
        ocrBboxHints: [
          {
            id: 19,
            label: "ocr_textline",
            x1: 320,
            y1: 140,
            x2: 520,
            y2: 240,
            score: 0.7,
            ocrText: "ビリリ！",
          },
          {
            id: 20,
            label: "ocr_textline",
            x1: 600,
            y1: 200,
            x2: 720,
            y2: 260,
            score: 0.99,
            ocrText: "あれ…",
          },
        ],
      },
      [baseVariant],
    );
    const translations = fixed.parseFixedBlockTranslationResponse(
      JSON.stringify({
        items: [
          { blockId: "B001", textRole: "sound", ko: "찌릿!" },
          { blockId: "B002", textRole: "ordinary", ko: "어라…" },
        ],
      }),
      plan,
      baseOptions,
    );

    expect(
      fixed.buildFixedBlockOverlayPayload(plan, translations).items,
    ).toEqual([
      expect.objectContaining({
        id: 19,
        x1: 320,
        y1: 140,
        x2: 520,
        y2: 240,
        textRole: "sound",
        confidence: 1,
      }),
      expect.objectContaining({
        id: 20,
        x1: 600,
        y1: 200,
        x2: 720,
        y2: 260,
        textRole: "ordinary",
        confidence: 0.99,
      }),
    ]);
  });

  it("validates and forwards a fine-grained visual font role", () => {
    const plan = twoSingletonPlan();
    const translations = fixed.parseFixedBlockTranslationResponse(
      JSON.stringify({
        items: [
          {
            blockId: "B001",
            textRole: "sound",
            fontRole: "sfx_impact",
            fontRoleConfidence: 0.96,
            visualClusterId: "  repeat－impact  ",
            ko: "쾅!",
          },
          {
            blockId: "B002",
            textRole: "ordinary",
            fontRole: "dialogue",
            fontRoleConfidence: 0.93,
            visual_cluster_id: "repeat-impact",
            ko: "그래.",
          },
        ],
      }),
      plan,
      { ...baseOptions, autoFontMatching: true },
    );

    expect(
      fixed.buildFixedBlockOverlayPayload(plan, translations).items,
    ).toEqual([
      expect.objectContaining({
        fontRole: "sfx_impact",
        fontRoleConfidence: 0.96,
        visualClusterId: "repeat-impact",
      }),
      expect.objectContaining({
        fontRole: "dialogue",
        fontRoleConfidence: 0.93,
        visualClusterId: "repeat-impact",
      }),
    ]);
    expect(translations.items[1]).not.toHaveProperty("visual_cluster_id");
  });

  it("treats invalid optional cluster ids as omitted legacy metadata", () => {
    const plan = twoSingletonPlan();
    for (const visualClusterId of [
      " ",
      "x".repeat(201),
      "../escape",
      "hidden\u0000cluster",
    ]) {
      const translations = fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            {
              blockId: "B001",
              textRole: "sound",
              fontRole: "sfx_impact",
              fontRoleConfidence: 0.96,
              visualClusterId,
              ko: "쾅!",
            },
            {
              blockId: "B002",
              textRole: "ordinary",
              fontRole: "dialogue",
              fontRoleConfidence: 0.93,
              ko: "그래.",
            },
          ],
        }),
        plan,
        { ...baseOptions, autoFontMatching: true },
      );

      expect(translations.items[0]).not.toHaveProperty("visualClusterId");
      expect(translations.items[1]).not.toHaveProperty("visualClusterId");
    }
  });

  it("rejects missing or invalid V2 visual-role evidence", () => {
    const plan = twoSingletonPlan();
    const invalid = {
      items: [
        {
          blockId: "B001",
          textRole: "sound",
          fontRole: "impactful-ish",
          fontRoleConfidence: 0.96,
          ko: "쾅!",
        },
        {
          blockId: "B002",
          textRole: "ordinary",
          ko: "그래.",
        },
      ],
    };

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(JSON.stringify(invalid), plan, {
        ...baseOptions,
        autoFontMatching: true,
      }),
    ).toThrow(/valid fontRole and fontRoleConfidence/i);
  });

  it("rejects an unknown visual text role", () => {
    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: [
            { blockId: "B001", textRole: "dialogue", ko: "오른쪽" },
            { blockId: "B002", textRole: "ordinary", ko: "왼쪽" },
          ],
        }),
        twoSingletonPlan(),
      ),
    ).toThrow(/textRole must be ordinary or sound/i);
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
    expect(prompt).toContain(
      "Each item has exactly three keys: blockId, textRole, and ko",
    );
    expect(prompt).toContain(
      'Use textRole "sound" only for standalone printed sound effects',
    );
    expect(prompt).toContain(
      "Japanese kana, kanji, iteration marks, and Japanese prolonged-sound marks are forbidden",
    );
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

  it("asks Gemma for visual intent without title or genre inference", () => {
    const prompt = fixed.buildFixedBlockTranslationPrompt(twoSingletonPlan(), {
      ...baseOptions,
      autoFontMatching: true,
    });

    expect(prompt).toContain(
      "Each item requires blockId, textRole, fontRole, fontRoleConfidence, and ko, and may additionally include visualClusterId",
    );
    expect(prompt).toContain("aside_balloon_edge");
    expect(prompt).toContain("Omit visualClusterId for dialogue");
    expect(prompt).toContain("never from the work title, genre stereotype");
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

function threeSingletonPlan(): FixedBlockPlan {
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
          ocrText: "一",
          score: 0.9,
        },
        {
          id: 2,
          x1: 530,
          y1: 100,
          x2: 580,
          y2: 300,
          ocrText: "二",
          score: 0.9,
        },
        {
          id: 3,
          x1: 460,
          y1: 100,
          x2: 510,
          y2: 300,
          ocrText: "三",
          score: 0.9,
        },
      ],
    },
    [baseVariant],
  );
}
