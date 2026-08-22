/* eslint-disable max-lines -- end-to-end pixel inference contracts share one fixture harness */
import { describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import {
  FONT_MATCHING_PAGE_INFERENCE_TIMEOUT_MS,
  runAutomaticFontMatchingV2PageStage,
} from "../src/main/pipeline/automaticFontMatchingV2PageStage";
import type { AutomaticFontPageCoordinatorV2 } from "../src/main/pipeline/automaticFontMatchingV2PageCoordinator";
import {
  createFontMatchingPageInferencePort,
  inferFontMatchingPagePixels,
  loadFontMatchingRuntimeModel,
  resolveFontMatchingOrtWasmAssets,
  type FontMatchingOnnxSession,
  type FontMatchingRuntimeModel,
} from "../src/main/pipeline/fontMatchingPagePixelInference";
import {
  USER_PAGE_FONT_MATCHING_BOUNDARY,
  type FontMatchingInferenceInputBoundary,
  type FontMatchingPageInferencePort,
  type VerifiedAutomaticFontPixelInferenceV2,
} from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import {
  FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
  FONT_MATCHING_SELECTION_FEATURE_CONTRACT,
  type FontMatchingSelectionCalibration,
  type FontMatchingSelectionOperatingPoint,
} from "../src/main/pipeline/fontMatchingSelectionCalibrationContract";
import { buildTranslatedPageResult } from "../src/main/pipeline/translatedPageResult";
import type { OverlayItem } from "../src/main/pipeline/types";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { AutomaticFontCandidate } from "../src/shared/fontMatchingTypes";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

// automaticFontMatchingV2PageStage now logs the 90s inference-deadline timeout
// via logWarn; in the test env electron's `app` is unavailable so logger would
// crash resolving the log path. Stub the logger surface used by the page stage
// (and any transitively-reached helpers) to no-ops.
vi.mock("../src/main/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  writeLog: vi.fn(),
  resetAppLog: vi.fn(),
  getLogPath: vi.fn(() => ""),
  getPreviousLogPath: vi.fn(() => ""),
  serializeLogDetail: vi.fn(() => ""),
}));

describe("whole-page Font Matching pixel inference", () => {
  it("keeps the compiled QA runtime bridge helpers public", () => {
    expect([
      createFontMatchingPageInferencePort,
      loadFontMatchingRuntimeModel,
      resolveFontMatchingOrtWasmAssets,
    ]).toEqual([
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ]);
  });

  it("keeps an empty runtime artifact path fail-closed as missing", async () => {
    await expect(
      loadFontMatchingRuntimeModel({
        artifactDir: "",
        installedCandidates: [],
        wasmAssets: { wasmBinaryPath: "unused", wasmModulePath: "unused" },
      }),
    ).resolves.toEqual({
      status: {
        state: "disabled",
        automaticMutationAllowed: false,
        semanticBootstrapAllowed: false,
        reason: "missing_artifact",
      },
      model: null,
    });
  });

  it("batches raw/context/glyph views and applies verified pixel ranking", async () => {
    const page = makePage();
    const item = makeItem();
    const candidates = makeCandidates();
    const toy = makeToyRuntime(candidates, {
      selectedIndex: 0,
      calibratedIndex: 1,
    });
    const port = toyPort(toy.model, makeRaster(), candidates);
    const pageOptions = makeOptions(candidates);

    const inference = await runAutomaticFontMatchingV2PageStage({
      jobId: "run-1",
      page,
      pageOptions,
      items: [item],
      port,
    });
    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page,
      pageOptions,
      items: [item],
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
      fontMatchingPageInference: inference,
    });

    expect(toy.encoderRun).toHaveBeenCalledTimes(1);
    expect(toy.encoderInputShapes).toEqual([[3, 3, 224, 224]]);
    expect(toy.rankerRun).toHaveBeenCalledTimes(1);
    expect(
      [...inference.pixelInferenceByBlockId.values()][0]?.selectionCalibration,
    ).toMatchObject({
      applied: true,
      fallbackReason: null,
      operatingFamily: "variant",
    });
    expect(
      [...inference.pixelInferenceByBlockId.values()][0]?.glyphMorphology,
    ).toMatchObject({
      contractVersion: "font-matching-glyph-morphology-v1",
      maskSource: "raw_grayscale_otsu_minority_area3",
      distanceTransform: "opencv_dist_l2_mask5",
      connectivity: 8,
    });
    expect(result.page.blocks[0]?.fontFamily).toBe("jua");
    expect(result.page.blocks[0]?.fontRole).toBe("sfx_impact");
  });

  it("rejects mixed cross-page and cross-catalog inference before page coordination", async () => {
    const page = makePage();
    const candidates = makeCandidates();
    const items = [0, 1, 2].map((index) => ({
      ...makeItem(),
      id: index + 1,
      bbox: { x: 100 + index * 10, y: 250, w: 780, h: 400 },
    }));
    const toy = makeToyRuntime(candidates, {
      selectedIndex: 4,
      calibratedIndex: 4,
    });
    const inferred = await runAutomaticFontMatchingV2PageStage({
      jobId: "mixed-run",
      page,
      pageOptions: makeOptions(candidates),
      items,
      port: toyPort(toy.model, makeRaster(), candidates),
    });
    const blockIds = [...inferred.pixelInferenceByBlockId.keys()];
    const sourceInferences = blockIds.map((blockId) => {
      const inference = inferred.pixelInferenceByBlockId.get(blockId);
      if (!inference) throw new Error(`missing inference for ${blockId}`);
      return forceDialogueWinner(inference, "nanum-gothic");
    });
    const valid = sourceInferences[0];
    const crossPage = {
      ...forceDialogueWinner(sourceInferences[1], "nanum-myeongjo"),
      pageId: "another-page",
    };
    const catalogBase = forceDialogueWinner(
      sourceInferences[2],
      "nanum-myeongjo",
    );
    const crossCatalog = {
      ...catalogBase,
      localEvidence: {
        ...catalogBase.localEvidence,
        catalogVersion: "wrong-catalog",
      },
    };
    const pageOptions = makeOptions(candidates);
    const common = {
      jobId: "mixed-run",
      page,
      pageOptions,
      items,
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    };
    const clean = buildTranslatedPageResult({
      ...common,
      fontMatchingPageInference: {
        runtimeArtifactStatus: inferred.runtimeArtifactStatus,
        pixelInferenceByBlockId: new Map([[blockIds[0], valid]]),
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
    const mixed = buildTranslatedPageResult({
      ...common,
      fontMatchingChapterCoordinator: chapterCoordinator,
      fontMatchingPageInference: {
        runtimeArtifactStatus: inferred.runtimeArtifactStatus,
        pixelInferenceByBlockId: new Map([
          [blockIds[0], valid],
          [blockIds[1], crossPage],
          [blockIds[2], crossCatalog],
        ]),
      },
    });

    expect(preparationOrder).toEqual([blockIds[0]]);
    expect(mixed.page.blocks[0].fontFamily).toBe("nanum-gothic");
    expect(mixed.page.blocks[0].fontRole).toBe(clean.page.blocks[0].fontRole);
    expect(mixed.page.blocks[1].fontFamily).toBeUndefined();
    expect(mixed.page.blocks[2].fontFamily).toBeUndefined();
  });

  it("uses failed release-quality points only for QA or an explicit manual-v2 acceptance", async () => {
    const candidates = makeCandidates();
    const production = makeToyRuntime(candidates, {
      selectedIndex: 0,
      calibratedIndex: 1,
      failedReleaseQuality: true,
    });
    const qaOnly = makeToyRuntime(candidates, {
      selectedIndex: 0,
      calibratedIndex: 1,
      failedReleaseQuality: true,
      qaOnlyRuntime: true,
    });
    const acceptedRelease = makeToyRuntime(candidates, {
      selectedIndex: 0,
      calibratedIndex: 1,
      failedReleaseQuality: true,
    });
    const acceptedReleaseModel = {
      ...acceptedRelease.model,
      failedCalibrationQualityAccepted: true,
    };
    const request = {
      page: makePage(),
      blocks: [{ blockId: "quality", item: makeItem() }],
      candidates,
      targetLanguage: "ko" as const,
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      loadRaster: async () => makeRaster(),
    };

    const productionResult = await inferFontMatchingPagePixels({
      ...request,
      model: production.model,
    });
    const qaOnlyResult = await inferFontMatchingPagePixels({
      ...request,
      model: qaOnly.model,
    });
    const acceptedReleaseResult = await inferFontMatchingPagePixels({
      ...request,
      model: acceptedReleaseModel,
    });

    expect(productionResult.get("quality")?.selectionCalibration.applied).toBe(
      false,
    );
    expect(qaOnlyResult.get("quality")?.selectionCalibration.applied).toBe(
      true,
    );
    expect(
      acceptedReleaseResult.get("quality")?.selectionCalibration.applied,
    ).toBe(true);
    expect(
      qaOnlyResult.get("quality")?.localEvidence.rankedCandidates[0]?.fontId,
    ).toBe(candidates[1]?.fontId);
    expect(
      acceptedReleaseResult.get("quality")?.localEvidence.rankedCandidates[0]
        ?.fontId,
    ).toBe(candidates[1]?.fontId);
  });

  it("routes body and variant scores from the pixel role", async () => {
    const candidates = makeCandidates();
    const variantToy = makeHybridToyRuntime(candidates, {
      bodyIndex: 0,
      variantIndex: 2,
      roleIndex: 7,
    });
    const variant = await inferFontMatchingPagePixels({
      page: makePage(),
      blocks: [{ blockId: "variant", item: makeItem() }],
      candidates,
      targetLanguage: "ko",
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      model: variantToy.model,
      loadRaster: async () => makeRaster(),
    });
    expect(variant.get("variant")?.scoreRoute).toEqual({
      family: "variant",
      outputName: "variant_candidate_scores",
      resolvedRole: "sfx_impact",
    });
    expect(
      variant.get("variant")?.localEvidence.rankedCandidates[0]?.fontId,
    ).toBe(candidates[2]?.fontId);

    const bodyToy = makeHybridToyRuntime(candidates, {
      bodyIndex: 1,
      variantIndex: 2,
      roleIndex: 0,
    });
    const bodyItem = {
      ...makeItem(),
      textRole: "dialogue" as const,
      fontRole: "dialogue" as const,
      fontRoleConfidence: 0.99,
    };
    const body = await inferFontMatchingPagePixels({
      page: makePage(),
      blocks: [{ blockId: "body", item: bodyItem }],
      candidates,
      targetLanguage: "ko",
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      model: bodyToy.model,
      loadRaster: async () => makeRaster(),
    });
    expect(body.get("body")?.scoreRoute).toEqual({
      family: "body",
      outputName: "body_candidate_scores",
      resolvedRole: "dialogue",
    });
    expect(body.get("body")?.localEvidence.rankedCandidates[0]?.fontId).toBe(
      candidates[1]?.fontId,
    );
  });

  it("masks Single Day for pixel dialogue before both ranking and calibration", async () => {
    const candidates = makeCandidates();
    const singleDayIndex = candidates.findIndex(
      ({ fontId }) => fontId === "single-day",
    );
    const dialogueToy = makeToyRuntime(candidates, {
      selectedIndex: singleDayIndex,
      calibratedIndex: singleDayIndex,
      roleIndex: 0,
    });
    const dialogue = await inferFontMatchingPagePixels({
      page: makePage(),
      blocks: [{ blockId: "dialogue-single-day", item: makeItem() }],
      candidates,
      targetLanguage: "ko",
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      model: dialogueToy.model,
      loadRaster: async () => makeRaster(),
    });
    const dialogueInference = dialogue.get("dialogue-single-day");
    const maskedSingleDay =
      dialogueInference?.localEvidence.rankedCandidates.find(
        ({ fontId }) => fontId === "single-day",
      );

    expect(dialogueInference?.rolePrediction.primary).toBe("dialogue");
    expect(
      dialogueInference?.localEvidence.rankedCandidates[0]?.fontId,
    ).not.toBe("single-day");
    expect(maskedSingleDay?.rawPixelRank).toBe(candidates.length);
    expect(dialogueInference?.selectionCalibration.applied).toBe(false);

    const sfxToy = makeToyRuntime(candidates, {
      selectedIndex: singleDayIndex,
      calibratedIndex: singleDayIndex,
      roleIndex: 7,
    });
    const sfx = await inferFontMatchingPagePixels({
      page: makePage(),
      blocks: [{ blockId: "sfx-single-day", item: makeItem() }],
      candidates,
      targetLanguage: "ko",
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      model: sfxToy.model,
      loadRaster: async () => makeRaster(),
    });

    expect(sfx.get("sfx-single-day")?.rolePrediction.primary).toBe(
      "sfx_impact",
    );
    expect(
      sfx.get("sfx-single-day")?.localEvidence.rankedCandidates[0]?.fontId,
    ).toBe("single-day");
    expect(sfx.get("sfx-single-day")?.selectionCalibration.applied).toBe(true);
  });

  it("keeps hybrid score, ranking, and selected font invariant under conflicting item roles", async () => {
    const candidates = makeCandidates();
    const toy = makeHybridToyRuntime(candidates, {
      bodyIndex: 1,
      variantIndex: 2,
      roleIndex: 0,
    });
    const geometry = makeItem().bbox;
    const inference = await inferFontMatchingPagePixels({
      page: makePage(),
      blocks: [
        {
          blockId: "gemma-dialogue",
          item: {
            ...makeItem(),
            bbox: geometry,
            textRole: "ordinary",
            fontRole: "dialogue",
            fontRoleConfidence: 1,
          },
        },
        {
          blockId: "gemma-sfx",
          item: {
            ...makeItem(),
            id: 2,
            bbox: geometry,
            textRole: "sound",
            fontRole: "sfx_impact",
            fontRoleConfidence: 1,
          },
        },
      ],
      candidates,
      targetLanguage: "ko",
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      model: toy.model,
      loadRaster: async () => makeRaster(),
    });
    const selectionSignature = (blockId: string) => {
      const result = inference.get(blockId);
      return {
        rolePrediction: result?.rolePrediction,
        scoreRoute: result?.scoreRoute,
        rankedCandidates: result?.localEvidence.rankedCandidates,
        selectedFontId:
          result?.localEvidence.rankedCandidates[0]?.fontId ?? null,
      };
    };

    expect(selectionSignature("gemma-dialogue")).toEqual(
      selectionSignature("gemma-sfx"),
    );
    expect(selectionSignature("gemma-dialogue")).toMatchObject({
      scoreRoute: {
        family: "body",
        outputName: "body_candidate_scores",
        resolvedRole: "dialogue",
      },
      selectedFontId: candidates[1]?.fontId,
    });
  });

  it("honors the sealed hybrid encoder and ranker batch sizes across 17 blocks", async () => {
    const candidates = makeCandidates();
    const toy = makeHybridToyRuntime(candidates, {
      bodyIndex: 0,
      variantIndex: 2,
      roleIndex: 7,
    });
    const blocks = Array.from({ length: 17 }, (_, index) => ({
      blockId: `variant-${index}`,
      item: makeItem(),
    }));

    const inference = await inferFontMatchingPagePixels({
      page: makePage(),
      blocks,
      candidates,
      targetLanguage: "ko",
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      model: toy.model,
      loadRaster: async () => makeRaster(),
    });

    expect(toy.encoderRun).toHaveBeenCalledTimes(26);
    expect(toy.encoderInputShapes.slice(0, 2)).toEqual([
      [2, 3, 224, 224],
      [2, 3, 224, 224],
    ]);
    expect(toy.encoderInputShapes.at(-1)).toEqual([1, 3, 224, 224]);
    expect(toy.rankerRun).toHaveBeenCalledTimes(2);
    expect(
      toy.rankerRun.mock.calls.map(([feeds]) => [
        ...tensorRecord(feeds.views).dims,
      ]),
    ).toEqual([
      [16, 3, 4],
      [1, 3, 4],
    ]);
    expect(inference.size).toBe(17);
    for (const row of inference.values()) {
      expect(row.scoreRoute?.family).toBe("variant");
      expect(row.localEvidence.rankedCandidates[0]?.fontId).toBe(
        candidates[2]?.fontId,
      );
    }
  });

  it("preserves the base ONNX order and confidence below the supervised threshold", async () => {
    const candidates = makeCandidates();
    const toy = makeToyRuntime(candidates, {
      selectedIndex: 0,
      calibratedIndex: 1,
      calibrationThreshold: 0.9999,
    });

    const inference = await inferFontMatchingPagePixels({
      page: makePage(),
      blocks: [{ blockId: "block-1", item: makeItem() }],
      candidates,
      targetLanguage: "ko",
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      model: toy.model,
      loadRaster: async () => makeRaster(),
    });
    const block = inference.get("block-1");

    expect(block?.localEvidence.rankedCandidates[0]?.fontId).toBe("dohyeon");
    expect(
      block?.localEvidence.rankedCandidates[0]?.confidence,
    ).toBeGreaterThan(0.9);
    expect(block?.selectionCalibration).toMatchObject({
      applied: false,
      fallbackReason: "score_below_operating_point",
      operatingFamily: null,
      selectionScore: null,
    });
  });

  it("hard-abstains when the verified none head crosses its threshold", async () => {
    const candidates = makeCandidates();
    const toy = makeToyRuntime(candidates, {
      selectedIndex: 0,
      calibratedIndex: 1,
      noneLogit: 9,
    });

    const inference = await inferFontMatchingPagePixels({
      page: makePage(),
      blocks: [{ blockId: "block-1", item: makeItem() }],
      candidates,
      targetLanguage: "ko",
      boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
      model: toy.model,
      loadRaster: async () => makeRaster(),
    });
    const block = inference.get("block-1");

    expect(block?.localEvidence.rankedCandidates[0]?.confidence).toBe(0);
    expect(block?.localEvidence.noneAcceptable).toBe(true);
    expect(block?.selectionCalibration).toMatchObject({
      applied: false,
      fallbackReason: "none_acceptable",
    });
  });

  it("keeps the existing font when the runtime artifact is disabled", async () => {
    const candidates = makeCandidates();
    const page = makePage();
    const item = makeItem();
    const pageOptions = makeOptions(candidates);
    const port: FontMatchingPageInferencePort = {
      inferPage: async () => ({
        runtimeArtifactStatus: {
          state: "disabled",
          automaticMutationAllowed: false,
          semanticBootstrapAllowed: false,
          reason: "missing_artifact",
        },
        pixelInferenceByBlockId: new Map(),
      }),
    };

    const inference = await runAutomaticFontMatchingV2PageStage({
      jobId: "run-1",
      page,
      pageOptions,
      items: [item],
      port,
    });
    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page,
      pageOptions,
      items: [item],
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
      fontMatchingPageInference: inference,
    });

    expect(result.page.blocks[0]?.fontFamily).toBeUndefined();
  });

  it("forwards caller-bound persistent block ids for keep-mode crops", async () => {
    const item = {
      ...makeItem(),
      direction: "horizontal" as const,
      sourceCandidateMembership: sourceMembership([1], "B001"),
    };
    const { sourceCandidateMembership: _membership, ...workerItem } = item;
    const pageOptions = makeOptions(makeCandidates());
    pageOptions.ocrBboxHints = [
      { id: item.id, x1: 10, y1: 10, x2: 30, y2: 90 },
    ];
    let receivedRequest:
      | Parameters<FontMatchingPageInferencePort["inferPage"]>[0]
      | undefined;
    const port: FontMatchingPageInferencePort = {
      inferPage: async (request) => {
        receivedRequest = request;
        return { pixelInferenceByBlockId: new Map() };
      },
    };

    await runAutomaticFontMatchingV2PageStage({
      jobId: "keep-run",
      page: makePage(),
      pageOptions,
      items: [item],
      inferenceBlocks: [{ blockId: "persisted-block-7", item }],
      port,
    });

    expect(receivedRequest?.blocks).toEqual([
      {
        blockId: "persisted-block-7",
        item: workerItem,
        sourceCandidateMembership: item.sourceCandidateMembership,
        sourceGeometryDirection: {
          contractVersion: "font-matching-ocr-geometry-direction-v2",
          source: "semantic_ocr_candidate_bbox_majority",
          direction: "vertical",
          candidateIds: [item.id],
          candidateMembership: item.sourceCandidateMembership,
        },
        sourceGlyphInput: {
          contractVersion: "font-matching-source-glyph-input-v1",
          source: "semantic_ocr_geometry_and_count_only",
          direction: "vertical",
          lines: [],
          fallbackGlyphCount: 2,
        },
      },
    ]);
    expect(receivedRequest?.boundary).toEqual(USER_PAGE_FONT_MATCHING_BOUNDARY);
  });

  it("does not derive direction from general fallback candidate ids", async () => {
    const item = { ...makeItem(), candidateIds: [1] };
    const pageOptions = makeOptions(makeCandidates());
    pageOptions.ocrBboxHints = [
      { id: item.id, x1: 10, y1: 10, x2: 30, y2: 90 },
    ];
    let receivedRequest:
      | Parameters<FontMatchingPageInferencePort["inferPage"]>[0]
      | undefined;
    const port: FontMatchingPageInferencePort = {
      inferPage: async (request) => {
        receivedRequest = request;
        return { pixelInferenceByBlockId: new Map() };
      },
    };

    await runAutomaticFontMatchingV2PageStage({
      jobId: "general-fallback-run",
      page: makePage(),
      pageOptions,
      items: [item],
      port,
    });

    expect(receivedRequest?.blocks).toEqual([
      expect.objectContaining({ item }),
    ]);
    expect(receivedRequest?.blocks[0]).not.toHaveProperty(
      "sourceGeometryDirection",
    );
  });

  it("transports exact-bound replay direction when page OCR hints are absent", async () => {
    const item = makeItem();
    const pageOptions = makeOptions(makeCandidates());
    pageOptions.ocrBboxHints = [];
    let receivedRequest:
      | Parameters<FontMatchingPageInferencePort["inferPage"]>[0]
      | undefined;
    const port: FontMatchingPageInferencePort = {
      inferPage: async (request) => {
        receivedRequest = request;
        return { pixelInferenceByBlockId: new Map() };
      },
    };

    await runAutomaticFontMatchingV2PageStage({
      jobId: "missing-geometry-run",
      page: makePage(),
      pageOptions,
      items: [item],
      inferenceBlocks: [
        {
          blockId: "persisted-block-8",
          item,
          sourceCandidateMembership: sourceMembership([item.id], "persisted-8"),
          sourceGeometryDirection: {
            contractVersion: "font-matching-ocr-geometry-direction-v2",
            source: "semantic_ocr_candidate_bbox_majority",
            direction: "horizontal",
            candidateIds: [item.id],
            candidateMembership: sourceMembership([item.id], "persisted-8"),
          },
        },
      ],
      port,
    });

    expect(receivedRequest?.blocks).toEqual([
      {
        blockId: "persisted-block-8",
        item,
        sourceCandidateMembership: sourceMembership([item.id], "persisted-8"),
        sourceGeometryDirection: {
          contractVersion: "font-matching-ocr-geometry-direction-v2",
          source: "semantic_ocr_candidate_bbox_majority",
          direction: "horizontal",
          candidateIds: [item.id],
          candidateMembership: sourceMembership([item.id], "persisted-8"),
        },
        sourceGlyphInput: {
          contractVersion: "font-matching-source-glyph-input-v1",
          source: "semantic_ocr_geometry_and_count_only",
          direction: "horizontal",
          lines: [],
          fallbackGlyphCount: 2,
        },
      },
    ]);
  });

  it("abstains instead of hanging the whole translation on stuck inference", async () => {
    vi.useFakeTimers();
    try {
      const candidates = makeCandidates();
      let inferenceSignal: AbortSignal | undefined;
      const port: FontMatchingPageInferencePort = {
        inferPage: async ({ signal }) => {
          inferenceSignal = signal;
          return await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      };
      const pending = runAutomaticFontMatchingV2PageStage({
        jobId: "run-timeout",
        page: makePage(),
        pageOptions: makeOptions(candidates),
        items: [makeItem()],
        port,
      });

      await vi.advanceTimersByTimeAsync(
        FONT_MATCHING_PAGE_INFERENCE_TIMEOUT_MS,
      );

      await expect(pending).resolves.toEqual({
        pixelInferenceByBlockId: expect.any(Map),
      });
      expect(inferenceSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on non-finite toy ONNX output", async () => {
    const candidates = makeCandidates();
    const toy = makeToyRuntime(candidates, {
      selectedIndex: 1,
      corruptCandidateScore: true,
    });
    const page = makePage();
    const item = makeItem();
    const pageOptions = makeOptions(candidates);
    const inference = await runAutomaticFontMatchingV2PageStage({
      jobId: "run-1",
      page,
      pageOptions,
      items: [item],
      port: toyPort(toy.model, makeRaster(), candidates),
    });
    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page,
      pageOptions,
      items: [item],
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
      fontMatchingPageInference: inference,
    });

    expect(inference.pixelInferenceByBlockId.size).toBe(0);
    expect(result.page.blocks[0]?.fontFamily).toBeUndefined();
  });

  it.each([
    [
      "frozen test split",
      { source: "user_page", datasetSplit: "test", qaOverlay: false },
    ],
    [
      "QA overlay",
      { source: "user_page", datasetSplit: null, qaOverlay: true },
    ],
  ])("forbids %s pixels before decoding", async (_label, rawBoundary) => {
    const candidates = makeCandidates();
    const toy = makeToyRuntime(candidates, { selectedIndex: 1 });
    const loadRaster = vi.fn(async () => makeRaster());

    await expect(
      inferFontMatchingPagePixels({
        page: makePage(),
        blocks: [{ blockId: "block-1", item: makeItem() }],
        candidates,
        targetLanguage: "ko",
        boundary: coerceBoundary(rawBoundary),
        model: toy.model,
        loadRaster,
      }),
    ).rejects.toThrow(/forbidden at runtime/);
    expect(loadRaster).not.toHaveBeenCalled();
  });

  it("rejects candidate-order drift before opening page pixels", async () => {
    const candidates = makeCandidates();
    const toy = makeToyRuntime(candidates, { selectedIndex: 1 });
    const loadRaster = vi.fn(async () => makeRaster());

    await expect(
      inferFontMatchingPagePixels({
        page: makePage(),
        blocks: [{ blockId: "block-1", item: makeItem() }],
        candidates: [...candidates].reverse(),
        targetLanguage: "ko",
        boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
        model: toy.model,
        loadRaster,
      }),
    ).rejects.toThrow(/candidate order drifted/);
    expect(loadRaster).not.toHaveBeenCalled();
  });
});

function toyPort(
  model: FontMatchingRuntimeModel,
  raster: ReturnType<typeof makeRaster>,
  candidates: readonly AutomaticFontCandidate[],
): FontMatchingPageInferencePort {
  return {
    async inferPage(request) {
      expect(request.candidates).toEqual(candidates);
      return {
        runtimeArtifactStatus: model.status,
        pixelInferenceByBlockId: await inferFontMatchingPagePixels({
          ...request,
          model,
          loadRaster: async () => raster,
        }),
      };
    },
  };
}

function makeToyRuntime(
  candidates: readonly AutomaticFontCandidate[],
  options: {
    selectedIndex: number;
    calibratedIndex?: number;
    calibrationThreshold?: number;
    noneLogit?: number;
    corruptCandidateScore?: boolean;
    failedReleaseQuality?: boolean;
    qaOnlyRuntime?: boolean;
    roleIndex?: number;
  },
) {
  const featureDim = 4;
  const encoderRun = vi.fn(async (feeds: Readonly<Record<string, unknown>>) => {
    const input = tensorRecord(feeds.pixel_values);
    const rows = input.dims[0] ?? 0;
    const data = new Float32Array(rows * featureDim);
    for (let row = 0; row < rows; row += 1) data[row * featureDim] = row + 1;
    return { image_features: tensor(data, [rows, featureDim]) };
  });
  const rankerRun = vi.fn(async (feeds: Readonly<Record<string, unknown>>) => {
    const input = tensorRecord(feeds.views);
    const rows = input.dims[0] ?? 0;
    const candidateScores = new Float32Array(rows * candidates.length);
    for (let row = 0; row < rows; row += 1) {
      candidateScores[row * candidates.length + options.selectedIndex] = 9;
    }
    if (options.corruptCandidateScore) candidateScores[0] = Number.NaN;
    return makeRankerOutputs(
      rows,
      candidates.length,
      candidateScores,
      options.noneLogit ?? -9,
      options.roleIndex,
    );
  });
  const encoder = session(["pixel_values"], ["image_features"], encoderRun);
  const ranker = session(
    ["views", "prototype_features"],
    rankerOutputNames(),
    rankerRun,
  );
  const encoderInputShapes: number[][] = [];
  encoderRun.mockImplementation(async (feeds) => {
    const input = tensorRecord(feeds.pixel_values);
    encoderInputShapes.push([...input.dims]);
    const rows = input.dims[0] ?? 0;
    const data = new Float32Array(rows * featureDim);
    return { image_features: tensor(data, [rows, featureDim]) };
  });
  const status = {
    state: "ready",
    automaticMutationAllowed: true,
    semanticBootstrapAllowed: false,
    modelVersion: "font-matching-runtime-v1-toy",
    catalogVersion: "active-catalog-toy",
    candidateIds: candidates.map(({ fontId }) => fontId),
    candidateOrderSha256: "a".repeat(64),
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
  } as const;
  const model: FontMatchingRuntimeModel = {
    status,
    encoder,
    ranker,
    createFloatTensor: tensor,
    candidateIds: status.candidateIds,
    encoderBatchSize: 24,
    featureDim,
    selectionFeatureDim: featureDim,
    prototypeCount: candidates.length,
    prototypeFeatures: new Float32Array(candidates.length * featureDim),
    selectionPrototypeFeatures: new Float32Array(
      candidates.length * featureDim,
    ),
    prototypeBags: candidates.map(({ fontId }, index) => ({
      candidateId: fontId,
      start: index,
      count: 1,
    })),
    rendererHash: "b".repeat(64),
    rankerOutputNames: rankerOutputNames(),
    rankerBatchSize: 16,
    scoreRouting: null,
    qaOnlyRuntime: options.qaOnlyRuntime ?? false,
    selectionCalibration: makeSelectionCalibration(
      candidates.map(({ fontId }) => fontId),
      options.calibratedIndex ?? options.selectedIndex,
      options.calibrationThreshold ?? 0.8,
      !(options.failedReleaseQuality ?? false),
    ),
  };
  return { model, encoderRun, rankerRun, encoderInputShapes };
}

function makeHybridToyRuntime(
  candidates: readonly AutomaticFontCandidate[],
  options: { bodyIndex: number; variantIndex: number; roleIndex: number },
) {
  const toy = makeToyRuntime(candidates, {
    selectedIndex: options.bodyIndex,
    calibratedIndex:
      options.roleIndex === 0 ? options.bodyIndex : options.variantIndex,
  });
  toy.rankerRun.mockImplementation(async (feeds) => {
    const input = tensorRecord(feeds.views);
    const rows = input.dims[0] ?? 0;
    const bodyScores = new Float32Array(rows * candidates.length);
    const variantScores = new Float32Array(rows * candidates.length);
    for (let row = 0; row < rows; row += 1) {
      bodyScores[row * candidates.length + options.bodyIndex] = 9;
      variantScores[row * candidates.length + options.variantIndex] = 9;
    }
    return {
      ...makeRankerOutputs(
        rows,
        candidates.length,
        bodyScores,
        -9,
        options.roleIndex,
      ),
      body_candidate_scores: tensor(bodyScores, [rows, candidates.length]),
      variant_candidate_scores: tensor(variantScores, [
        rows,
        candidates.length,
      ]),
    };
  });
  return {
    ...toy,
    model: {
      ...toy.model,
      encoderBatchSize: 2,
      rankerOutputNames: hybridRankerOutputNames(),
      rankerBatchSize: 16,
      scoreRouting: {
        bodyRoles: new Set(["dialogue", "narration", "thought"] as const),
        bodyOutput: "body_candidate_scores" as const,
        variantOutput: "variant_candidate_scores" as const,
        selectionFeatureDim: toy.model.selectionFeatureDim,
      },
    },
  };
}

function makeRankerOutputs(
  rows: number,
  candidateCount: number,
  candidateScores: Float32Array,
  noneLogit: number,
  roleIndex = 7,
) {
  const role = logits(rows, 14, roleIndex);
  return {
    candidate_scores: tensor(candidateScores, [rows, candidateCount]),
    none_logits: tensor(
      Float32Array.from({ length: rows }, () => noneLogit),
      [rows],
    ),
    role_logits: tensor(role, [rows, 14]),
    style_logits: tensor(new Float32Array(rows * 10), [rows, 10]),
    treatment_distortion_logits: tensor(logits(rows, 8, 0), [rows, 8]),
    treatment_fill_logits: tensor(logits(rows, 6, 0), [rows, 6]),
    treatment_orientation_logits: tensor(logits(rows, 4, 0), [rows, 4]),
    treatment_outline_logits: tensor(logits(rows, 5, 0), [rows, 5]),
    treatment_shadow_logits: tensor(logits(rows, 5, 0), [rows, 5]),
    view_gate_weights: tensor(
      Float32Array.from({ length: rows * 3 }, () => 1 / 3),
      [rows, 3],
    ),
  };
}

function logits(rows: number, columns: number, selected: number): Float32Array {
  const values = Float32Array.from({ length: rows * columns }, () => -8);
  for (let row = 0; row < rows; row += 1) {
    values[row * columns + selected] = 8;
  }
  return values;
}

function session(
  inputNames: readonly string[],
  outputNames: readonly string[],
  run: FontMatchingOnnxSession["run"],
): FontMatchingOnnxSession {
  return { inputNames, outputNames, run };
}

function tensor(data: Float32Array, dims: readonly number[]) {
  return { data, dims, dispose: vi.fn() };
}

function tensorRecord(value: unknown): ReturnType<typeof tensor> {
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !("dims" in value)
  ) {
    throw new Error("missing toy tensor");
  }
  return value as ReturnType<typeof tensor>;
}

function rankerOutputNames(): string[] {
  return [
    "candidate_scores",
    "none_logits",
    "role_logits",
    "style_logits",
    "treatment_distortion_logits",
    "treatment_fill_logits",
    "treatment_orientation_logits",
    "treatment_outline_logits",
    "treatment_shadow_logits",
    "view_gate_weights",
  ];
}

function hybridRankerOutputNames(): string[] {
  const names = rankerOutputNames();
  names.splice(1, 0, "body_candidate_scores", "variant_candidate_scores");
  return names;
}

function makeCandidates(): AutomaticFontCandidate[] {
  return [
    "dohyeon",
    "jua",
    "gaegu",
    "gowun-batang",
    "nanum-gothic",
    "nanum-myeongjo",
    "black-han-sans",
    "dokdo",
    "east-sea-dokdo",
    "gugi",
    "hi-melody",
    "poor-story",
    "single-day",
    "song-myung",
    "stylish",
  ].map((fontId, index) =>
    makeAutomaticFontCandidate({
      fontId,
      source: "built-in",
      unicodeRanges: [[0, 0x10ffff]],
      preferenceRank: index,
      defaultFont: index === 0,
      serif: index % 3 === 0,
      weight: 100 + (index % 9) * 100,
      width: 1 + (index % 9),
    }),
  );
}

function makeSelectionCalibration(
  candidateIds: readonly string[],
  calibratedIndex: number,
  threshold: number,
  releaseQualityPassed = true,
): FontMatchingSelectionCalibration {
  const featureNames = [
    ...FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
    ...candidateIds.map(
      (candidateId) => `candidate_id::${candidateId}` as const,
    ),
  ];
  const coefficients = Array.from({ length: featureNames.length }, () => 0);
  coefficients[
    FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES.length + calibratedIndex
  ] = 10;
  const point = {
    ...makeOperatingPoint(threshold),
    precision_target_passed: releaseQualityPassed,
    preferred_at1: releaseQualityPassed ? 1 : 0.4,
  };
  return {
    schemaVersion: "font-matching-selection-calibration-v1",
    recordType: "font_matching_selection_calibration",
    recordSha256: "c".repeat(64),
    bindings: {
      model_version: "font-matching-runtime-v1-toy",
      candidate_order_sha256: "a".repeat(64),
      runtime_contract_sha256: "1".repeat(64),
      encoder_sha256: "2".repeat(64),
      ranker_sha256: "3".repeat(64),
      prototype_features_sha256: "4".repeat(64),
      catalog_registry_sha256: "5".repeat(64),
      catalog_registry_record_sha256: "6".repeat(64),
      frozen_split_map_sha256: "7".repeat(64),
      master_manifest_sha256: "8".repeat(64),
      master_report_sha256: "9".repeat(64),
      master_split_map_sha256: "a".repeat(64),
      finals_sha256: "b".repeat(64),
    },
    candidateIds,
    featureNames,
    featureContract: FONT_MATCHING_SELECTION_FEATURE_CONTRACT,
    scaler: {
      mean: featureNames.map(() => 0),
      scale: featureNames.map(() => 1),
    },
    logistic: { coef: coefficients, intercept: -5, c: 1 },
    operatingPoints: { body: point, variant: point, global: point },
    leakageAudit: {},
    oofReport: {},
    trainingBoundary: {},
  };
}

function makeOperatingPoint(
  selectionScoreThreshold: number,
): FontMatchingSelectionOperatingPoint {
  return {
    enabled: true,
    selection_score_threshold: selectionScoreThreshold,
    coverage_target: 0.9,
    coverage_floor_passed: true,
    precision_target: 0.9,
    precision_target_passed: true,
    risk_lcb: 0.9,
    cohort_count: 10,
    accepted_count: 9,
    eligible_count: 10,
    normal_sample_count: 10,
    normal_accepted_count: 9,
    none_sample_count: 0,
    none_false_accept_count: 0,
    none_abstained_count: 0,
    hit_count: 9,
    miss_count: 0,
    coverage: 0.9,
    acceptable_at1: 1,
    preferred_at1: 1,
    overall_decision_accuracy: 0.9,
    none_abstention_rate: 1,
  };
}

function makeRaster() {
  const width = 100;
  const height = 100;
  const bgra = new Uint8Array(width * height * 4);
  bgra.fill(255);
  for (let y = 35; y < 55; y += 1) {
    for (let x = 25; x < 75; x += 1) {
      if ((x - 25) % 12 > 5) continue;
      const offset = (y * width + x) * 4;
      bgra[offset] = 0;
      bgra[offset + 1] = 0;
      bgra[offset + 2] = 0;
      bgra[offset + 3] = 255;
    }
  }
  return { width, height, bgra };
}

function makeItem(): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    textRole: "sound",
    fontRole: "sfx_impact",
    fontRoleConfidence: 0.98,
    bbox: { x: 100, y: 250, w: 800, h: 400 },
    jp: "ドン",
    ko: "쾅",
    confidence: 1,
  };
}

function sourceMembership(candidateIds: number[], bindingId: string) {
  return {
    contractVersion: "font-matching-ocr-candidate-membership-v2" as const,
    source: "semantic_ocr_fixed_block_request_v6" as const,
    bindingId,
    originalCandidateIds: candidateIds,
    voterCandidateIds: candidateIds,
  };
}

function forceDialogueWinner(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  fontId: string,
): VerifiedAutomaticFontPixelInferenceV2 {
  const rankedCandidates = [...inference.localEvidence.rankedCandidates]
    .sort((left, right) => {
      if (left.fontId === fontId) return -1;
      if (right.fontId === fontId) return 1;
      return left.rank - right.rank;
    })
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      rawPixelRank: index + 1,
      totalScore:
        candidate.fontId === fontId
          ? 0.99
          : Math.min(candidate.totalScore, 0.2),
      confidence: candidate.fontId === fontId ? 0.97 : 0,
    }));
  return {
    ...inference,
    rolePrediction: {
      primary: "dialogue",
      confidence: 0.99,
      alternatives: [],
    },
    scoreRoute: {
      family: "body",
      outputName: "body_candidate_scores",
      resolvedRole: "dialogue",
    },
    selectionCalibration: {
      ...inference.selectionCalibration,
      applied: true,
      fallbackReason: null,
      operatingFamily: "body",
      selectionScore: 0.97,
    },
    localEvidence: {
      ...inference.localEvidence,
      rankedCandidates,
      calibratedConfidence: 0.97,
      noneAcceptable: false,
    },
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

function makeOptions(
  candidates: readonly AutomaticFontCandidate[],
): TranslationOptions {
  return {
    autoFontMatching: true,
    targetLanguage: "ko",
    fontMatchingCandidates: candidates,
  } as TranslationOptions;
}

function coerceBoundary(value: unknown): FontMatchingInferenceInputBoundary {
  return value as FontMatchingInferenceInputBoundary;
}
