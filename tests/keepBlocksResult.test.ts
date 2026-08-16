import { describe, expect, it } from "vitest";
import { joinCropOcrTexts } from "../src/main/pipeline/keepBlocksOcr";
import {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
  resolveFontMatchingV2CatalogVersion,
} from "../src/main/pipeline/automaticFontMatchingV2";
import type { AutomaticFontPageCoordinatorV2 } from "../src/main/pipeline/automaticFontMatchingV2PageCoordinator";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRuntimeArtifactStatus } from "../src/main/pipeline/fontMatchingRuntimeArtifactStatus";
import {
  applyOverlayItemsToExistingBlocks,
  buildKeepBlocksOcrResult,
  shouldKeepExistingBlocks,
} from "../src/main/pipeline/keepBlocksResult";
import { buildKeepBlocksFontInferenceBlocks } from "../src/main/pipeline/keepBlocksAssignment";
import { buildPreviousBlocksForPrompt } from "../src/main/pipeline/previousBlocksForPrompt";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { OverlayItem } from "../src/main/pipeline/types";
import type { WorkTypographyProfileV2 } from "../src/shared/fontMatchingProfileTypes";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

describe("keep-blocks translation mode", () => {
  it("keeps existing blocks only when keep mode is on and blocks exist", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
    ]);
    expect(shouldKeepExistingBlocks("keep", page)).toBe(true);
    expect(shouldKeepExistingBlocks("auto", page)).toBe(false);
    expect(shouldKeepExistingBlocks(undefined, page)).toBe(false);
    expect(shouldKeepExistingBlocks("keep", makePage([]))).toBe(false);
  });

  it("synthesizes pixel-space OCR hints with sequential ids from blocks", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 200, w: 300, h: 100 }),
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }),
    ]);
    const result = buildKeepBlocksOcrResult(page);
    expect(result.noTextDetected).toBe(false);
    expect(result.textEvidenceCount).toBe(2);
    expect(result.hints).toEqual([
      expect.objectContaining({ id: 1, x1: 100, y1: 300, x2: 400, y2: 450 }),
      expect.objectContaining({ id: 2, x1: 500, y1: 750, x2: 600, y2: 900 }),
    ]);
  });

  it("attaches per-block crop OCR texts to the synthetic hints", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 200, w: 300, h: 100 }),
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }),
    ]);
    const result = buildKeepBlocksOcrResult(page, ["誰も!彼も!", undefined]);
    expect(result.hints[0]).toEqual(
      expect.objectContaining({ id: 1, ocrText: "誰も!彼も!" }),
    );
    expect(result.hints[1]).not.toHaveProperty("ocrText");
  });

  it("joins crop OCR texts in Japanese reading order and skips junk hints", () => {
    const joined = joinCropOcrTexts([
      { x1: 10, y1: 10, x2: 40, y2: 200, ocrText: "ばかり" },
      { x1: 100, y1: 10, x2: 130, y2: 200, ocrText: "その" },
      { x1: 55, y1: 10, x2: 85, y2: 200, ocrText: "女" },
      { x1: 55, y1: 10, x2: 85, y2: 200, ocrText: "   " },
      { ocrText: "좌표없음" },
      null,
    ]);
    expect(joined).toBe("その 女 ばかり");
  });

  it("orders same-column horizontal lines top to bottom", () => {
    const joined = joinCropOcrTexts([
      { x1: 10, y1: 60, x2: 200, y2: 90, ocrText: "二行目" },
      { x1: 12, y1: 10, x2: 198, y2: 40, ocrText: "一行目" },
    ]);
    expect(joined).toBe("一行目 二行目");
  });

  it("orders non-Japanese OCR left to right and then top to bottom", () => {
    const joined = joinCropOcrTexts(
      [
        { x1: 110, y1: 10, x2: 200, y2: 40, ocrText: "world" },
        { x1: 10, y1: 60, x2: 200, y2: 90, ocrText: "second line" },
        { x1: 10, y1: 10, x2: 100, y2: 40, ocrText: "Hello" },
      ],
      "en",
    );

    expect(joined).toBe("Hello world second line");
  });

  it("orders right-to-left OCR within each line", () => {
    const joined = joinCropOcrTexts(
      [
        { x1: 10, y1: 10, x2: 100, y2: 40, ocrText: "العالم" },
        { x1: 110, y1: 10, x2: 200, y2: 40, ocrText: "مرحبا" },
      ],
      "ar-SA",
    );

    expect(joined).toBe("مرحبا العالم");
  });

  it("omits the sound role hint for freshly drawn empty blocks", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }, "쿵"),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    expect(previousBlocks[0].textRole).toBeUndefined();
    expect(previousBlocks[1].textRole).toBe("sound");
  });

  it("maps items to blocks by candidate id, preserving geometry and format", () => {
    const manualBubbleLayout: NonNullable<TranslationBlock["bubbleLayout"]> = {
      version: 1,
      direction: "horizontal",
      confidence: 1,
      origin: "manual",
      modelId: "manual-shape-v1",
      insetRatio: 0.05,
      regions: [
        {
          spans: [
            {
              blockStart: 0.05,
              blockEnd: 0.95,
              inlineStart: 0.1,
              inlineEnd: 0.9,
            },
          ],
        },
      ],
    };
    const page = makePage([
      {
        ...makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }, "이전 번역"),
        renderBbox: { x: 80, y: 80, w: 240, h: 140 },
        renderBboxSpace: "normalized_1000",
        bubbleLayout: manualBubbleLayout,
      },
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const items: OverlayItem[] = [
      makeItem(2, { x: 510, y: 505, w: 90, h: 90 }, "こんにちは", "안녕하세요"),
      makeItem(1, { x: 105, y: 100, w: 195, h: 95 }, "ありがとう", "고마워"),
    ];

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items,
      previousBlocks,
    });

    expect(mapping.updatedCount).toBe(2);
    expect(mapping.keptCount).toBe(0);
    expect(mapping.droppedItemCount).toBe(0);
    expect(mapping.blocks[0]).toMatchObject({
      id: "b-1",
      bbox: { x: 100, y: 100, w: 200, h: 100 },
      sourceText: "ありがとう",
      translatedText: "고마워",
      fontSizePx: 24,
      renderBbox: { x: 80, y: 80, w: 240, h: 140 },
      bubbleLayout: manualBubbleLayout,
    });
    expect(mapping.blocks[1]).toMatchObject({
      id: "b-2",
      sourceText: "こんにちは",
      translatedText: "안녕하세요",
    });
  });

  it("binds keep-mode inference crops to persistent ids in item order", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const second = makeItem(
      2,
      { x: 510, y: 505, w: 90, h: 90 },
      "こんにちは",
      "안녕하세요",
    );
    const first = makeItem(
      1,
      { x: 105, y: 100, w: 195, h: 95 },
      "ありがとう",
      "고마워",
    );

    expect(
      buildKeepBlocksFontInferenceBlocks({
        page,
        items: [second, first],
        previousBlocks,
      }),
    ).toEqual([
      { blockId: "b-2", item: second },
      { blockId: "b-1", item: first },
    ]);
  });

  it("replaces an existing keep-mode font when verified pixels select another", () => {
    const candidate = makeAutomaticFontCandidate({
      source: "built-in",
      fontId: "nanum-barun-gothic",
    });
    const page = makePage([
      {
        ...makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
        fontFamily: "legacy-current-font",
      },
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const catalogVersion = resolveFontMatchingV2CatalogVersion([candidate]);
    const status = makeReadyRuntimeStatus(candidate.fontId, catalogVersion);
    const inference = makeVerifiedKeepInference(
      page.id,
      page.blocks[0].id,
      candidate.fontId,
      catalogVersion,
    );

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [makeItem(1, page.blocks[0].bbox, "ありがとう", "고마워")],
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
        candidates: [candidate],
        pageInference: {
          runtimeArtifactStatus: status,
          pixelInferenceByBlockId: new Map([[page.blocks[0].id, inference]]),
        },
      },
    });

    expect(mapping.blocks[0]).toMatchObject({
      fontFamily: "nanum-barun-gothic",
    });
  });

  it("processes verified keep blocks body-first without reordering stored blocks", () => {
    const bodyCandidate = makeAutomaticFontCandidate({
      source: "built-in",
      fontId: "nanum-barun-gothic",
    });
    const variantCandidate = makeAutomaticFontCandidate({
      source: "built-in",
      fontId: "dohyeon",
    });
    const candidates = [bodyCandidate, variantCandidate];
    const page = makePage([
      makeBlock("b-accent", { x: 100, y: 100, w: 200, h: 100 }),
      makeBlock("b-body", { x: 100, y: 300, w: 200, h: 100 }),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const status = makeReadyRuntimeStatus(
      candidates.map(({ fontId }) => fontId),
      catalogVersion,
    );
    const accentInference = {
      ...makeVerifiedKeepInference(
        page.id,
        "b-accent",
        variantCandidate.fontId,
        catalogVersion,
        candidates.map(({ fontId }) => fontId),
      ),
      rolePrediction: {
        primary: "dialogue" as const,
        confidence: 1 / 14,
        alternatives: [],
      },
      sourceStyle: makeNeutralKeepSourceStyle(),
      selectionCalibration: {
        applied: true,
        fallbackReason: null,
        operatingFamily: "variant" as const,
        selectionScore: 0.97,
        globalRiskLowerConfidenceBound: 0.9,
      },
    };
    const bodyInference = makeVerifiedKeepInference(
      page.id,
      "b-body",
      bodyCandidate.fontId,
      catalogVersion,
      candidates.map(({ fontId }) => fontId),
    );
    const neutralBodyInference = {
      ...bodyInference,
      rolePrediction: {
        primary: "dialogue" as const,
        confidence: 1 / 14,
        alternatives: [],
      },
      sourceStyle: makeNeutralKeepSourceStyle(),
    };
    const preparationOrder: string[] = [];
    const chapterCoordinator = {
      prepareWorkState(_item, _role, inference) {
        if (inference) preparationOrder.push(inference.blockId);
        return undefined;
      },
      recordDecision() {},
    } satisfies AutomaticFontPageCoordinatorV2;

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [
        makeItem(1, page.blocks[0].bbox, "ドン", "쾅"),
        makeItem(2, page.blocks[1].bbox, "ありがとう", "고마워"),
      ],
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pageCoordinator: chapterCoordinator,
        pageInference: {
          runtimeArtifactStatus: status,
          pixelInferenceByBlockId: new Map([
            ["b-accent", accentInference],
            ["b-body", neutralBodyInference],
          ]),
        },
      },
    });

    expect(preparationOrder).toEqual(["b-body", "b-accent"]);
    expect(mapping.blocks.map((block) => block.id)).toEqual([
      "b-accent",
      "b-body",
    ]);
    expect(mapping.blocks.map((block) => block.fontFamily)).toEqual([
      variantCandidate.fontId,
      bodyCandidate.fontId,
    ]);
  });

  it("excludes cross-page and cross-catalog keep inference from page state", () => {
    const candidate = makeAutomaticFontCandidate({
      source: "built-in",
      fontId: "nanum-barun-gothic",
    });
    const page = makePage([
      {
        ...makeBlock("b-valid", { x: 100, y: 100, w: 200, h: 100 }),
        fontFamily: "legacy-valid",
      },
      {
        ...makeBlock("b-cross-page", { x: 100, y: 300, w: 200, h: 100 }),
        fontFamily: "legacy-cross-page",
      },
      {
        ...makeBlock("b-cross-catalog", { x: 100, y: 500, w: 200, h: 100 }),
        fontFamily: "legacy-cross-catalog",
      },
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const items = page.blocks.map((block, index) =>
      makeItem(index + 1, block.bbox, `原文${index}`, `번역${index}`),
    );
    const catalogVersion = resolveFontMatchingV2CatalogVersion([candidate]);
    const status = makeReadyRuntimeStatus(candidate.fontId, catalogVersion);
    const valid = makeVerifiedKeepInference(
      page.id,
      "b-valid",
      candidate.fontId,
      catalogVersion,
    );
    const crossPage = {
      ...makeVerifiedKeepInference(
        page.id,
        "b-cross-page",
        candidate.fontId,
        catalogVersion,
      ),
      pageId: "another-page",
    };
    const catalogBase = makeVerifiedKeepInference(
      page.id,
      "b-cross-catalog",
      candidate.fontId,
      catalogVersion,
    );
    const crossCatalog = {
      ...catalogBase,
      localEvidence: {
        ...catalogBase.localEvidence,
        catalogVersion: "wrong-catalog",
      },
    };
    const clean = applyOverlayItemsToExistingBlocks({
      page,
      items,
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
        candidates: [candidate],
        pageInference: {
          runtimeArtifactStatus: status,
          pixelInferenceByBlockId: new Map([["b-valid", valid]]),
        },
      },
    });
    const preparationOrder: string[] = [];
    const chapterCoordinator = {
      prepareWorkState(_item, _role, inference) {
        if (inference) preparationOrder.push(inference.blockId);
        return undefined;
      },
      recordDecision() {},
    } satisfies AutomaticFontPageCoordinatorV2;

    const mixed = applyOverlayItemsToExistingBlocks({
      page,
      items,
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
        candidates: [candidate],
        pageCoordinator: chapterCoordinator,
        pageInference: {
          runtimeArtifactStatus: status,
          pixelInferenceByBlockId: new Map([
            ["b-valid", valid],
            ["b-cross-page", crossPage],
            ["b-cross-catalog", crossCatalog],
          ]),
        },
      },
    });

    expect(preparationOrder).toEqual(["b-valid"]);
    expect(mixed.blocks[0].fontFamily).toBe(clean.blocks[0].fontFamily);
    expect(mixed.blocks[0].fontRole).toBe(clean.blocks[0].fontRole);
    expect(mixed.blocks[1].fontFamily).toBe("legacy-cross-page");
    expect(mixed.blocks[2].fontFamily).toBe("legacy-cross-catalog");
  });

  it("preserves a manual block font lock without pixel inference", () => {
    const candidate = makeAutomaticFontCandidate({
      source: "built-in",
      fontId: "jua",
    });
    const page = makePage([
      {
        ...makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
        fontFamily: "legacy-current-font",
      },
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [makeItem(1, page.blocks[0].bbox, "ありがとう", "고마워")],
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        candidates: [candidate],
        profile: makeKeepProfile([candidate], candidate.fontId),
      },
    });

    expect(mapping.blocks[0]).toMatchObject({
      fontFamily: candidate.fontId,
    });
  });

  it("keeps unmatched blocks untouched and drops out-of-block items", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }, "기존 유지"),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const items: OverlayItem[] = [
      makeItem(7, { x: 800, y: 800, w: 100, h: 100 }, "無関係", "무관"),
    ];

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items,
      previousBlocks,
    });

    expect(mapping.updatedCount).toBe(0);
    expect(mapping.keptCount).toBe(1);
    expect(mapping.droppedItemCount).toBe(1);
    expect(mapping.blocks[0].translatedText).toBe("기존 유지");
  });

  it("falls back to bbox overlap when the model returns an unknown id", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const items: OverlayItem[] = [
      makeItem(9, { x: 110, y: 105, w: 180, h: 90 }, "はい", "네"),
    ];

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items,
      previousBlocks,
    });

    expect(mapping.updatedCount).toBe(1);
    expect(mapping.blocks[0].translatedText).toBe("네");
  });

  it("adds hard breaks while preserving an existing block's formatting", () => {
    const original = {
      ...makeBlock("b-1", { x: 100, y: 100, w: 72, h: 180 }),
      wordBreak: "keep-all" as const,
      fontWidthScale: 0.9,
    };
    const page = makePage([original]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [
        makeItem(
          1,
          { x: 100, y: 100, w: 72, h: 180 },
          "超人工知能翻訳技術",
          "초인공지능번역기술",
        ),
      ],
      previousBlocks,
      naturalLayout: { enabled: true, locale: "ko" },
    });

    expect(mapping.blocks[0].translatedText).toBe("초인공지능번역기술");
    expect(mapping.blocks[0]).toMatchObject({
      bbox: original.bbox,
      renderDirection: original.renderDirection,
      wordBreak: "keep-all",
      fontWidthScale: 0.9,
    });
  });

  it("leaves a keep-mode block unchanged when verified evidence is absent", () => {
    const candidate = makeAutomaticFontCandidate();
    const page = makePage([
      {
        ...makeBlock("b-1", { x: 100, y: 100, w: 120, h: 180 }),
        fontFamily: candidate.fontId,
      },
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [
        makeItem(1, page.blocks[0].bbox, "長い台詞です", "긴 대사입니다"),
      ],
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
        candidates: [candidate],
      },
      naturalLayout: { enabled: true, locale: "ko" },
    });

    expect(mapping.blocks[0].fontFamily).toBe(candidate.fontId);
    expect(mapping.blocks[0]).not.toHaveProperty("fontMetricWidthScale");
  });

  it("leaves the renderer default unchanged when verified evidence is absent", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 120, h: 180 }),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [
        makeItem(1, page.blocks[0].bbox, "長い台詞です", "긴 대사입니다"),
      ],
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
        candidates: [
          makeAutomaticFontCandidate({
            source: "built-in",
            fontId: "dohyeon",
          }),
        ],
      },
    });

    expect(mapping.blocks[0]).not.toHaveProperty("fontFamily");
  });

  it("preserves an existing sound role when the model omits it", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 160, h: 120 }, "쾅"),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const item = {
      ...makeItem(1, page.blocks[0].bbox, "ドン", "쾅!"),
      textRole: undefined,
    };

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [item],
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
      },
    });

    expect(previousBlocks[0].textRole).toBe("sound");
    expect(mapping.blocks[0].fontFamily).toBeUndefined();
    expect(mapping.blocks[0].textRole).toBe("sound");
  });

  it("persists a new model-classified sound role across keep retranslations", () => {
    const page = makePage([
      {
        ...makeBlock(
          "b-1",
          { x: 100, y: 100, w: 160, h: 120 },
          "긴 일반문으로 저장된 블록",
        ),
        textRole: "ordinary",
      },
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [
        {
          ...makeItem(1, page.blocks[0].bbox, "ビリリ！", "찌릿!"),
          textRole: "sound",
          confidence: 1,
        },
      ],
      previousBlocks,
      automaticFont: {
        enabled: true,
        targetLanguage: "ko",
      },
    });

    expect(mapping.blocks[0].textRole).toBe("sound");
    expect(mapping.blocks[0].fontFamily).not.toBe("nanum-barun-gothic");
    expect(
      buildPreviousBlocksForPrompt(makePage(mapping.blocks), [])[0].textRole,
    ).toBe("sound");
  });

  it("lets an explicit visual ordinary role correct a legacy short-text guess", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 160, h: 120 }, "네"),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    expect(previousBlocks[0].textRole).toBe("sound");

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [
        {
          ...makeItem(1, page.blocks[0].bbox, "はい", "네"),
          textRole: "ordinary",
        },
      ],
      previousBlocks,
    });

    expect(mapping.blocks[0].textRole).toBe("ordinary");
  });

  it("trusts a persisted ordinary role instead of guessing from short text", () => {
    const page = makePage([
      {
        ...makeBlock("b-1", { x: 100, y: 100, w: 160, h: 120 }, "네"),
        textRole: "ordinary",
      },
    ]);

    expect(buildPreviousBlocksForPrompt(page, [])[0].textRole).toBe("ordinary");
  });

  it("adds hard breaks to a legacy block without adding wordBreak", () => {
    const original = makeBlock(
      "b-1",
      { x: 100, y: 100, w: 100, h: 120 },
      "이전 번역",
    );
    const page = makePage([original]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    }).map((block) => ({ ...block, textRole: "ordinary" as const }));
    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [
        makeItem(
          1,
          original.bbox,
          "既存ブロックの折り返し設定はそのままです",
          "기존 블록의 줄바꿈 서식은 그대로 둡니다",
        ),
      ],
      previousBlocks,
      naturalLayout: { enabled: true, locale: "ko" },
    });

    expect(mapping.blocks[0]?.translatedText).toContain("\n");
    expect(mapping.blocks[0]?.wordBreak).toBeUndefined();
    expect(original.wordBreak).toBeUndefined();
  });

  it("does not disturb curve text while applying natural layout", () => {
    const curved = {
      ...makeBlock("b-1", { x: 100, y: 100, w: 72, h: 180 }),
      curveLayout: {
        version: 1 as const,
        path: {
          type: "quadratic" as const,
          start: { x: 0, y: 500 },
          control: { x: 500, y: 0 },
          end: { x: 1000, y: 500 },
        },
        alignment: "center" as const,
        offsetEm: 0,
        orientation: "tangent" as const,
      },
    };
    const page = makePage([curved]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items: [
        makeItem(1, curved.bbox, "超人工知能翻訳技術", "초인공지능번역기술"),
      ],
      previousBlocks,
      naturalLayout: { enabled: true, locale: "ko" },
    });

    expect(mapping.blocks[0].translatedText).toBe("초인공지능번역기술");
    expect(mapping.blocks[0].curveLayout).toEqual(curved.curveLayout);
  });
});

function makePage(blocks: TranslationBlock[]): MangaPage {
  return {
    id: "page-1",
    name: "001.jpg",
    imagePath: "001.jpg",
    dataUrl: "",
    width: 1000,
    height: 1500,
    blocks,
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(
  id: string,
  bbox: TranslationBlock["bbox"],
  translatedText = "",
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox,
    bboxSpace: "normalized_1000",
    sourceText: "",
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    rotationDeg: 0,
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: true,
  };
}

function makeItem(
  id: number,
  bbox: OverlayItem["bbox"],
  jp: string,
  ko: string,
): OverlayItem {
  return {
    id,
    type: "nonsolid",
    textRole: "ordinary",
    bbox,
    jp,
    ko,
    confidence: 0.95,
  };
}

function makeReadyRuntimeStatus(
  fontId: string | readonly string[],
  catalogVersion: string,
): FontMatchingRuntimeArtifactStatus {
  const candidateIds = typeof fontId === "string" ? [fontId] : [...fontId];
  return {
    state: "ready",
    automaticMutationAllowed: true,
    semanticBootstrapAllowed: false,
    modelVersion: "keep-runtime-v1",
    catalogVersion,
    candidateIds,
    candidateOrderSha256: "keep-candidate-order-v1",
    calibration: { temperature: 1, noneThreshold: 0.5 },
    policy: {
      automaticMutation: {
        minimumAutomaticConfidence: 0.86,
        minimumRoleConfidence: 0.82,
        minimumIntentionalOverrideConfidence: 0.86,
        intentionalOverrideMinimumScoreMargin: 0.1,
      },
      chapterPrior: {
        maximumScoreContribution: 0.06,
        minimumAnchorEvidenceCount: 2,
        localOverrideMinimumScoreMargin: 0.1,
      },
    },
  };
}

function makeVerifiedKeepInference(
  pageId: string,
  blockId: string,
  fontId: string,
  catalogVersion: string,
  candidateIds: readonly string[] = [fontId],
): VerifiedAutomaticFontPixelInferenceV2 {
  const orderedFontIds = [
    fontId,
    ...candidateIds.filter((candidateId) => candidateId !== fontId),
  ];
  return {
    kind: "verified_pixel_inference",
    pageId,
    blockId,
    modelVersion: "keep-runtime-v1",
    candidateOrderSha256: "keep-candidate-order-v1",
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: { primary: "dialogue", confidence: 0.99, alternatives: [] },
    sourceStyle: {
      serifness: 0.2,
      weight: 0.5,
      width: 0.5,
      roundness: 0.5,
      strokeContrast: 0.3,
      handwritten: 0.1,
      angularity: 0.2,
      irregularity: 0.1,
      slant: 0.1,
      energy: 0.2,
      unknownFields: [],
    },
    treatment: {
      orientation: "horizontal",
      outline: "none",
      shadow: "none",
      fill: "solid",
      distortion: "none",
      polarity: "normal",
      colorMode: "monochrome",
    },
    selectionCalibration: {
      applied: true,
      fallbackReason: null,
      operatingFamily: "body",
      selectionScore: 0.97,
      globalRiskLowerConfidenceBound: 0.9,
    },
    glyphMorphology: {
      contractVersion: "font-matching-glyph-morphology-v1",
      maskSource: "raw_grayscale_otsu_minority_area3",
      distanceTransform: "opencv_dist_l2_mask5",
      connectivity: 8,
      maskWidth: 80,
      maskHeight: 40,
      otsuThreshold: 100,
      foregroundPolarity: "dark",
      foregroundPixelCount: 240,
      connectedComponentCount: 3,
      globalForegroundDistanceMean: 1.8,
      medianComponentDistanceMean: 1.8,
      medianComponentFill: 0.62,
      foregroundMeanLuma: 30,
      backgroundMeanLuma: 230,
    },
    localEvidence: {
      rankedCandidates: orderedFontIds.map(
        (candidateId, index) =>
          ({
            rank: index + 1,
            fontId: candidateId,
            renderStatus: "rendered",
            unrenderableReason: null,
            styleFit: index === 0 ? 0.97 : 0.4,
            roleFit: index === 0 ? 0.97 : 0.4,
            layoutFit: 0,
            glyphCoverage: 1,
            workProfileFit: 0,
            userPreferenceFit: 0,
            genrePriorContribution: 0,
            switchPenalty: 0,
            totalScore: index === 0 ? 0.97 : 0.4,
            confidence: index === 0 ? 0.97 : 0,
            rawPixelRank: index + 1,
            rawPixelScore: index === 0 ? 0.97 : 0.4,
            reasonCodes: ["pixel_model"],
          }) satisfies VerifiedAutomaticFontPixelInferenceV2["localEvidence"]["rankedCandidates"][number],
      ),
      calibratedConfidence: 0.97,
      noneAcceptable: false,
      catalogVersion,
      modelVersion: "keep-runtime-v1",
      rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    },
  };
}

function makeNeutralKeepSourceStyle(): VerifiedAutomaticFontPixelInferenceV2["sourceStyle"] {
  return {
    serifness: 0.5,
    weight: 0.5,
    width: 0.5,
    roundness: 0.5,
    strokeContrast: 0.5,
    handwritten: 0.5,
    angularity: 0.5,
    irregularity: 0.5,
    slant: 0.5,
    energy: 0.5,
    unknownFields: [],
  };
}

function makeKeepProfile(
  candidates: readonly ReturnType<typeof makeAutomaticFontCandidate>[],
  lockedFontId: string,
): WorkTypographyProfileV2 {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    schemaVersion: 2,
    workId: "work-1",
    dialogueAnchor: null,
    narrationAnchor: null,
    thoughtAnchor: null,
    rolePalettes: [],
    intentionalOverrides: [],
    userLocks: [
      {
        id: "keep-block-lock",
        scope: {
          type: "block",
          chapterId: "chapter-1",
          pageId: "page-1",
          blockId: "b-1",
        },
        selection: { fontId: lockedFontId },
        createdAt: now,
        updatedAt: now,
      },
    ],
    orientationPolicy: {
      horizontalAllowedFontIds: null,
      verticalAllowedFontIds: null,
      verticalOnlyFontIds: [],
    },
    consistencyPolicy: {
      reuseBodyAnchors: true,
      requireIntentionalOverrideForBodySwitch: true,
      reuseVisualClusterFont: true,
      maxAccentFontsPerRole: 4,
    },
    genrePrior: null,
    evidenceCount: 1,
    confidence: 1,
    catalogVersion: resolveFontMatchingV2CatalogVersion(candidates),
    modelVersion: FONT_MATCHING_V2_MODEL_VERSION,
    rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    createdAt: now,
    updatedAt: now,
  };
}
