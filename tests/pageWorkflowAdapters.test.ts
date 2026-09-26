import { PageWorkflowPartialFailure } from "../src/main/application/pageWorkflowPartialFailure";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  detectWorkflowBlocks,
  readWorkflowSource,
} from "../src/main/pageWorkflow/pageWorkflowOcr";
import {
  executePageWorkflow,
  type PageWorkflowExecutionPort,
} from "../src/main/application/pageWorkflowService";
import { runWholePagePipeline } from "../src/main/wholePagePipeline";
import { buildKeepBlocksOcrResult } from "../src/main/pipeline/keepBlocksResult";
import { workflowConfigurationKeys } from "../src/main/pageWorkflow/pageWorkflowConfiguration";
import { translateWorkflowPage } from "../src/main/pageWorkflow/pageWorkflowTranslation";
import { mergeWorkflowTypography } from "../src/main/pageWorkflow/pageWorkflowTypographyMerge";
import { prepareWorkflowTypographyPage } from "../src/main/pageWorkflow/pageWorkflowTypographyInput";
import { preparePageResult } from "../src/main/pipeline/pageResultBuilder";
import { estimateSourceFontSizeForItem } from "../src/main/pipeline/sourceFontSizeEstimator";
import { successTranslationResult } from "./helpers/wholePageTranslationResults";
import { layoutWorkflowPage } from "../src/main/pageWorkflow/pageWorkflowImages";
import {
  buildBaseOptions,
  buildPageOptions,
} from "../src/main/pipeline/options";
import { createPageWorkflowPlan } from "../src/shared/pageWorkflowTypes";
import {
  workflowRegionKey,
  workflowStageKey,
} from "../src/shared/pageWorkflowPolicy";
import type { PageWorkflowRuntimeContext } from "../src/main/pageWorkflow/pageWorkflowRuntimeTypes";
import { makePage, makeChapter } from "./helpers/workspacePointerFixtures";
import {
  basePipelineOptions,
  cleanupPipelineTempDirs,
  loadPipeline,
  makeEmptyWorkContext,
} from "./helpers/wholePagePipelineHarness";

afterEach(cleanupPipelineTempDirs);

async function fixture() {
  const harness = await loadPipeline();
  const settings = await harness.dependencies.settings.getAppSettings();
  settings.ocr.pipeline = "hayai";
  const page = makePage({ blockPatch: { sourceText: "", translatedText: "" } });
  const options = basePipelineOptions([page], []);
  const context: PageWorkflowRuntimeContext = {
    runId: "test-run",
    plan: { ...createPageWorkflowPlan(["ocr"]), cumulative: false },
    rules: {},
    settings,
    paths: harness.dependencies.paths,
    dependencies: harness.dependencies,
    signal: options.signal,
    emit: vi.fn(options.emit),
    runPaths: async () => options.runPaths,
    decodeImage: async () => null,
  };
  const base = buildBaseOptions(
    context.runId,
    options.runPaths.runDir,
    settings,
    context.paths,
  );
  return {
    ...harness,
    context,
    page,
    options: buildPageOptions(base, page, 0, 1),
  };
}

describe("independent Hayai workflow adapters", () => {
  it("matches the legacy kept-block OCR geometry and raster size inputs", async () => {
    const f = await fixture();
    f.page.blocks[0] = {
      ...f.page.blocks[0],
      sourceText: "原文文字",
      bbox: { x: 100, y: 100, w: 100, h: 30 },
      translatedText: "안녕",
      confidence: 0.95,
    };
    const prepared = prepareWorkflowTypographyPage(
      f.page,
      0,
      f.options,
      f.context,
    );
    const result = successTranslationResult();
    const response = JSON.parse(result.outputText);
    response.items[0].candidateIds = [1];
    Object.assign(response.items[0], { jp: "原文文字", x2: 200, y2: 130 });
    result.outputText = JSON.stringify(response);
    result.requestBody = {
      ocrBboxHints: prepared.pageOptions.ocrBboxHints,
      fixedBlockTranslationVersion: 6,
      fixedBlockIds: ["B001"],
      fixedBlockCandidateIds: [[1]],
      fixedBlockDirectionVoterCandidateIds: [[1]],
    };
    const legacy = await preparePageResult({
      jobId: f.context.runId,
      page: f.page,
      pageOptions: prepared.pageOptions,
      result,
      runtime: f.dependencies.runtime,
    });
    if (legacy.kind !== "translated")
      throw new Error("Expected legacy text result");
    const before = legacy.fontInferenceItems[0];
    const after = prepared.fontInferenceItems[0];
    expect(after.bbox).toEqual(before.bbox);
    expect(after.sourceFontLineGeometry).toEqual(before.sourceFontLineGeometry);
    expect(after.sourceCandidateMembership).toEqual(
      before.sourceCandidateMembership,
    );
    const raster = {
      width: 1000,
      height: 1000,
      bgra: new Uint8Array(1000 * 1000 * 4).fill(255),
    };
    for (let glyph = 0; glyph < 4; glyph++) {
      for (let y = 105; y < 125; y++) {
        for (let x = 105 + glyph * 23; x < 117 + glyph * 23; x++) {
          raster.bgra.fill(0, (y * 1000 + x) * 4, (y * 1000 + x) * 4 + 3);
        }
      }
    }
    const estimate = estimateSourceFontSizeForItem(raster, before);
    expect(estimate?.facePx).toBeGreaterThan(0);
    expect(estimateSourceFontSizeForItem(raster, after)).toEqual(estimate);
  });

  it("reads only missing source at existing geometry without translation or detection", async () => {
    const f = await fixture();
    f.page.inpaintedImagePath = "saved-clean.png";
    f.page.blocks[0].translatedText = "수동 번역";
    const recognition = vi.fn(async (options) => {
      const manifest = JSON.parse(
        await readFile(options.ocrBboxRegionsPath, "utf8"),
      );
      expect(manifest.dialogueRegions[0].bbox).toEqual([100, 100, 300, 200]);
      return {
        diagnostics: [],
        width: 1000,
        height: 1000,
        hints: [{ id: 1, ocrText: "교정할 원문" }],
      };
    });
    const output = await readWorkflowSource(f.page, f.options, f.context.plan, {
      ...f.dependencies.runtime,
      collectPreparedHayaiHints: recognition,
    });
    expect(output).toEqual({
      ...f.page,
      blocks: [{ ...f.page.blocks[0], sourceText: "교정할 원문" }],
    });
    expect(f.runtime.startEndpointSession).not.toHaveBeenCalled();
    expect(f.runtime.collectOcrHintsBatch).not.toHaveBeenCalled();
    await readWorkflowSource(output, f.options, f.context.plan, {
      ...f.dependencies.runtime,
      collectPreparedHayaiHints: recognition,
    });
    expect(recognition).toHaveBeenCalledOnce();
  });

  it("translation uses corrected saved source and preserves IDs, geometry, erasure and styles", async () => {
    const f = await fixture();
    f.context.plan = {
      ...createPageWorkflowPlan(["translate"]),
      cumulative: false,
    };
    f.page.blocks[0].sourceText = "ユーザーが修正した原文";
    f.page.blocks[0].fontSizePx = 39;
    f.page.blocks[0].fontSizeIntent = "manual";
    f.page.inpaintedImagePath = "saved-clean.png";
    const request = vi.spyOn(f.dependencies.runtime, "requestTranslation");
    const work = makeEmptyWorkContext();
    const result = await translateWorkflowPage(
      f.context,
      makeChapter(f.page),
      f.page,
      async () => ({ ...work, workTitle: "Test" }),
    );
    expect(f.runtime.collectOcrHintsBatch).not.toHaveBeenCalled();
    expect(f.dependencies.runtime.collectOcrHints).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalled();
    expect(request.mock.calls[0][1].ocrBboxHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ocrText: f.page.blocks[0].sourceText }),
      ]),
    );
    expect(result.blocks[0]).toMatchObject({
      ...f.page.blocks[0],
      translatedText: "안녕",
    });
    expect(result.inpaintedImagePath).toBe(f.page.inpaintedImagePath);
  });

  it.each([
    { source: "ドキドキ…", translation: "두근두근…" },
    { source: "はぁ", translation: "하아" },
  ])(
    "preserves the reported 0.99-confidence translation: $source",
    async ({ source, translation }) => {
      const f = await fixture();
      f.context.plan = {
        ...createPageWorkflowPlan(["translate"]),
        cumulative: false,
      };
      f.page.blocks[0].sourceText = source;
      const response = successTranslationResult();
      const payload = JSON.parse(response.outputText);
      Object.assign(payload.items[0], {
        jp: source,
        ko: translation,
        textRole: "sound",
        confidence: 0.99,
      });
      response.outputText = JSON.stringify(payload);
      vi.mocked(f.dependencies.runtime.requestTranslation).mockResolvedValue(
        response,
      );
      const result = await translateWorkflowPage(
        f.context,
        makeChapter(f.page),
        f.page,
        async () => ({ ...makeEmptyWorkContext(), workTitle: "Test" }),
      );
      expect(result.blocks[0]).toMatchObject({
        ...f.page.blocks[0],
        translatedText: translation,
      });
      expect(result.analysisStatus).toBe("completed");
    },
  );

  it.each([
    { overwrite: false, filterSound: false },
    { overwrite: true, filterSound: false },
    { overwrite: false, filterSound: true },
    { overwrite: true, filterSound: true },
  ])(
    "retains fixed-slot sounds and resumes omitted empty translations (%j)",
    async ({ overwrite, filterSound }) => {
      const f = await fixture();
      f.context.plan = {
        ...createPageWorkflowPlan([
          "translate",
          "typography",
          "erase",
          "layout",
          "review",
        ]),
        cumulative: false,
        overwrite: overwrite ? ["translate"] : [],
      };
      f.page.name = "8.jpg";
      f.page.inpaintedImagePath = "existing-clean.png";
      f.page.blocks = Array.from({ length: 9 }, (_, index) => ({
        ...f.page.blocks[0],
        id: `block-${index + 1}`,
        sourceText: index === 7 ? "ぴ" : `原文${index + 1}`,
        translatedText: overwrite ? `이전 번역 ${index + 1}` : "",
        bbox: { x: 20 + index * 100, y: 100, w: 70, h: 100 },
        fontSizePx: 39,
      }));
      const response = successTranslationResult();
      response.outputText = JSON.stringify({
        items: f.page.blocks.flatMap((block, index) =>
          index === 7 && !filterSound
            ? []
            : [
                {
                  id: index + 1,
                  type: index === 7 ? "nonsolid" : "speech",
                  textRole: index === 7 ? "sound" : "ordinary",
                  x1: block.bbox.x,
                  y1: 100,
                  x2: block.bbox.x + 70,
                  y2: 200,
                  jp: block.sourceText,
                  ko: `번역 ${index + 1}`,
                  direction: "horizontal",
                  confidence: 0.99,
                },
              ],
        ),
      });
      const request = vi.mocked(f.dependencies.runtime.requestTranslation);
      request.mockResolvedValue(response);
      const legacy = await runWholePagePipeline(
        {
          ...basePipelineOptions([f.page], []),
          blockMode: "keep",
          preparedOcrHints: new Map([
            [
              f.page.id,
              buildKeepBlocksOcrResult(
                f.page,
                f.page.blocks.map((block) => block.sourceText),
              ),
            ],
          ]),
          autoFontMatching: false,
          aiFontSizeMatching: false,
          naturalTextLayout: false,
        },
        f.dependencies,
      );
      expect(legacy.pages[0].analysisStatus).toBe("completed");
      request.mockClear();
      let chapter = makeChapter(f.page);
      const port: PageWorkflowExecutionPort = {
        readChapter: async () => structuredClone(chapter),
        acquirePage: async () => chapter.pages[0],
        releasePage: vi.fn(),
        prepareStage: async () => {},
        progress: vi.fn(),
        isFatal: () => false,
        execute: vi.fn(async (stage, current, page) =>
          stage === "translate"
            ? translateWorkflowPage(
                { ...f.context },
                current,
                page,
                async () => ({ ...makeEmptyWorkContext(), workTitle: "Test" }),
              )
            : { ...page, inpaintedImagePath: "saved-clean.png" },
        ),
        save: vi.fn(async (_chapter, before, after) => {
          expect(before).toEqual(chapter.pages[0]);
          chapter = { ...chapter, pages: [JSON.parse(JSON.stringify(after))] };
        }),
      };
      const execution = {
        runId: f.context.runId,
        plan: f.context.plan,
        signal: f.context.signal,
        configurationKeys: workflowConfigurationKeys(f.context.settings),
        selection: [{ chapterId: chapter.id, pageIds: [f.page.id] }],
      };
      const result = await executePageWorkflow(execution, port);
      const missing = !overwrite && !filterSound;
      expect(result.status).toBe(missing ? "partial" : "completed");
      expect(result.issues).toHaveLength(missing ? 1 : 0);
      const saved = chapter.pages[0];
      expect(saved.blocks.map((block) => block.translatedText)).toEqual(
        legacy.pages[0].blocks.map((block) => block.translatedText),
      );
      expect(saved.blocks[7].translatedText).toBe(
        filterSound ? "번역 8" : overwrite ? "이전 번역 8" : "",
      );
      expect(saved.analysisStatus).toBe(missing ? "failed" : "completed");
      expect(saved.pageWorkflow?.steps.translate?.status).toBe(
        missing ? "failed" : "completed",
      );
      expect(saved.inpaintedImagePath).toBe(
        missing ? "existing-clean.png" : "saved-clean.png",
      );
      expect(f.context.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ phase: "page_done" }),
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(port.execute).mock.calls.map(([stage]) => stage),
      ).toEqual(
        missing
          ? ["translate"]
          : ["translate", "typography", "erase", "layout", "review"],
      );
      if (missing) {
        response.outputText = JSON.stringify({
          items: [
            {
              id: 1,
              type: "nonsolid",
              textRole: "sound",
              x1: 720,
              y1: 100,
              x2: 790,
              y2: 200,
              jp: "ぴ",
              ko: "번역 8",
              direction: "horizontal",
              confidence: 0.99,
            },
          ],
        });
      }
      expect((await executePageWorkflow(execution, port)).status).toBe(
        "completed",
      );
      expect(request).toHaveBeenCalledTimes(missing ? 2 : 1);
      if (missing)
        expect(request.mock.calls[1][1].ocrBboxHints).toHaveLength(1);
      for (const [index, block] of chapter.pages[0].blocks.entries()) {
        expect(block).toMatchObject({
          ...JSON.parse(JSON.stringify(f.page.blocks[index])),
          translatedText:
            index === 7 && overwrite && !filterSound
              ? "이전 번역 8"
              : "번역 " + (index + 1),
        });
      }
      expect(chapter.pages[0].analysisStatus).toBe("completed");
      expect(chapter.pages[0].lastError).toBeUndefined();
      expect(chapter.pages[0].inpaintedImagePath).toBe("saved-clean.png");
    },
  );

  it("retains saved translations and leaves omitted blocks available for review", async () => {
    const f = await fixture();
    f.context.plan = {
      ...createPageWorkflowPlan(["translate"]),
      cumulative: false,
    };
    f.page.blocks[0].sourceText = "原文";
    f.page.blocks.push(
      {
        ...f.page.blocks[0],
        id: "missing",
        sourceText: "ぴ",
        bbox: { x: 700, y: 700, w: 50, h: 50 },
      },
      {
        ...f.page.blocks[0],
        id: "manual",
        sourceText: "保存",
        translatedText: "수동 번역",
      },
    );
    const error = await translateWorkflowPage(
      f.context,
      makeChapter(f.page),
      f.page,
      async () => ({ ...makeEmptyWorkContext(), workTitle: "Test" }),
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PageWorkflowPartialFailure);
    if (!(error instanceof PageWorkflowPartialFailure)) throw error;
    expect(error.message).toContain("1개 블록의 번역문이 비어 있습니다");
    expect(error.page.blocks.map((block) => block.translatedText)).toEqual([
      "안녕",
      "",
      "수동 번역",
    ]);
    expect(f.page.blocks[0].translatedText).toBe("");
  });

  it("ignores retired retry targets in older development receipts", async () => {
    const f = await fixture();
    f.context.plan = {
      ...createPageWorkflowPlan(["translate"]),
      cumulative: false,
      overwrite: ["translate"],
    };
    f.page.blocks[0].sourceText = "原文";
    f.page.blocks[0].translatedText = "첫 번역";
    f.page.blocks.push({
      ...f.page.blocks[0],
      id: "second",
      bbox: { x: 700, y: 700, w: 50, h: 50 },
    });
    f.page.pageWorkflow = {
      runId: f.context.runId,
      planKey: hashStableValue(f.context.plan),
      findings: [],
      steps: {
        translate: {
          status: "failed",
          inputKey: "before",
          outputKey: workflowStageKey(f.page, "translate"),
          retryBlockIds: ["second"],
          configurationKey: workflowConfigurationKeys(f.context.settings)
            .translate,
        },
      },
    };
    const result = await translateWorkflowPage(
      f.context,
      makeChapter(f.page),
      f.page,
      async () => ({ ...makeEmptyWorkContext(), workTitle: "Test" }),
    );
    expect(result.analysisStatus).toBe("completed");
    expect(result.blocks.map((block) => block.translatedText)).toEqual([
      "안녕",
      "첫 번역",
    ]);
    expect(
      vi.mocked(f.dependencies.runtime.requestTranslation).mock.calls[0][1]
        .ocrBboxHints,
    ).toHaveLength(2);
  });

  it("still rejects an actual model request failure", async () => {
    const f = await fixture();
    f.context.plan = {
      ...createPageWorkflowPlan(["translate"]),
      cumulative: false,
    };
    f.page.blocks[0].sourceText = "原文";
    vi.mocked(f.dependencies.runtime.requestTranslation).mockRejectedValue(
      new Error("OpenAI Codex request failed: 401 Unauthorized"),
    );
    await expect(
      translateWorkflowPage(
        f.context,
        makeChapter(f.page),
        f.page,
        async () => ({ ...makeEmptyWorkContext(), workTitle: "Test" }),
      ),
    ).rejects.toThrow(/401 Unauthorized/);
    expect(f.page.blocks[0].translatedText).toBe("");
  });

  it("clears a translation failure after the remaining text was filled manually", async () => {
    const f = await fixture();
    f.context.plan = createPageWorkflowPlan(["translate"]);
    f.page.blocks[0].sourceText = "原文";
    f.page.blocks[0].translatedText = "수동 번역";
    f.page.analysisStatus = "failed";
    f.page.lastError = "누락";
    const result = await translateWorkflowPage(
      f.context,
      makeChapter(f.page),
      f.page,
    );
    expect(result.analysisStatus).toBe("completed");
    expect(result.lastError).toBeUndefined();
    expect(result.blocks).toEqual(f.page.blocks);
    expect(f.dependencies.runtime.requestTranslation).not.toHaveBeenCalled();
  });

  it("preserves existing blocks on detection and represents a successful empty detection", async () => {
    const f = await fixture();
    const detector = vi.fn();
    expect(
      await detectWorkflowBlocks(
        f.page,
        f.options,
        createPageWorkflowPlan(["detect"]),
        detector,
      ),
    ).toBe(f.page);
    expect(detector).not.toHaveBeenCalled();
    detector.mockResolvedValue({
      manifest: { dialogueRegions: [], effectRegions: [] },
    });
    const empty = await detectWorkflowBlocks(
      { ...f.page, blocks: [] },
      f.options,
      createPageWorkflowPlan(["detect"]),
      detector,
    );
    expect(empty.blocks).toEqual([]);
    expect(empty.analysisStatus).toBe("idle");
    empty.pageWorkflow = {
      runId: "run",
      planKey: "plan",
      steps: {},
      findings: [],
      emptyDetectionKey: workflowStageKey(empty, "detect"),
    };
    expect(
      await detectWorkflowBlocks(
        empty,
        f.options,
        createPageWorkflowPlan(["detect"]),
        detector,
      ),
    ).toBe(empty);
    expect(detector).toHaveBeenCalledOnce();
  });

  it("does not replace manual typography unless reapply is requested", async () => {
    const { page } = await fixture();
    const plan = createPageWorkflowPlan(["typography"]);
    page.blocks[0].fontFamily = "Manual";
    page.blocks[0].fontSizeIntent = "manual";
    page.blocks[0].workflowOrigin = {
      geometryKey: workflowRegionKey(page, page.blocks[0]),
      initialFontSize: 24,
      initialFontFamily: "Original",
    };
    const auto = {
      ...page,
      blocks: [
        {
          ...page.blocks[0],
          fontFamily: "Automatic",
          fontSizePx: 48,
          fontSizeIntent: "source-match" as const,
        },
      ],
    };
    expect(mergeWorkflowTypography(page, auto, plan).blocks[0]).toMatchObject({
      fontFamily: "Manual",
      fontSizePx: 24,
      fontSizeIntent: "manual",
    });
    expect(
      mergeWorkflowTypography(page, auto, {
        ...plan,
        overwrite: ["typography"],
      }).blocks[0],
    ).toMatchObject({ fontFamily: "Automatic", fontSizePx: 48 });
  });

  it("natural layout preserves existing balloon placement and manual line breaks", async () => {
    const f = await fixture();
    f.context.plan = {
      ...createPageWorkflowPlan(["layout"]),
      bubbleLayout: false,
      naturalLayout: true,
    };
    const page = makePage({
      withBubbleLayout: true,
      blockPatch: { translatedText: "이것은 길게 쓴 수동 번역문입니다" },
    });
    expect(await layoutWorkflowPage(f.context, page)).toEqual(page);
    const manual = makePage({
      blockPatch: { translatedText: "첫 줄\n둘째 줄" },
    });
    expect(await layoutWorkflowPage(f.context, manual)).toEqual(manual);
  });
});
