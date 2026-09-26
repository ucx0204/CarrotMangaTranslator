import { afterEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationOptions } from "../src/main/appSettings";
import type { PreparedTranslationCheckpoint } from "../src/main/pipeline/preparedTranslationCheckpointContract";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  basePipelineOptions,
  cleanupPipelineTempDirs,
  loadPipeline,
  makeEmptyWorkContext,
  makePage,
} from "./helpers/wholePagePipelineHarness";
import {
  successTranslationResult,
  translationWithPageContext,
} from "./helpers/wholePageTranslationResults";
import {
  PreparedTranslationCheckpointValidationError,
  resolveCheckpointCompatibility,
} from "../src/main/pipeline/preparedTranslationCheckpoint";
import {
  approvePreparedTranslationCheckpoint,
  requireTranslationEndpoint,
} from "../src/main/pipeline/wholePageCheckpointFlow";

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await cleanupPipelineTempDirs();
});

describe("whole page translation checkpoints", () => {
  it("does not reuse a kept-block checkpoint that discarded sound translations", async () => {
    const page = makePage("page-a", "001.png");
    let checkpoint: PreparedTranslationCheckpoint | undefined;
    const pipeline = await loadPipeline();
    await pipeline.runWholePagePipeline({
      ...basePipelineOptions([page], []),
      onPagePrepared: async (value) => {
        checkpoint = value;
        return true;
      },
    });
    if (!checkpoint || checkpoint.prepared.kind !== "translated")
      throw new Error("Expected translated checkpoint");
    checkpoint.blockMode = "keep";
    checkpoint.prepared.soundDroppedCount = 1;
    expect(
      resolveCheckpointCompatibility({ checkpoint, page, blockMode: "keep" }),
    ).toEqual({
      reusable: false,
      reason: "kept-sound-translations-dropped",
    });
    checkpoint.prepared.soundDroppedCount = 0;
    expect(
      resolveCheckpointCompatibility({ checkpoint, page, blockMode: "keep" }),
    ).toEqual({ reusable: true });
  });

  it("propagates unexpected checkpoint preparation errors without marking a page skipped", async () => {
    type Options = Parameters<typeof approvePreparedTranslationCheckpoint>[0];
    const error = new Error("timing data unavailable");
    const onValidationFailed = vi.fn();
    const onPagePrepared = vi.fn();
    await expect(
      approvePreparedTranslationCheckpoint({
        page: makePage("page-a", "001.png"),
        signal: new AbortController().signal,
        prepared: {} as Options["prepared"],
        run: { baseOptions: {} } as Options["run"],
        timing: {
          getStages: (
            _pageId: string,
          ): ReturnType<Options["timing"]["getStages"]> => {
            throw error;
          },
        } as Options["timing"],
        onPagePrepared,
        onValidationFailed,
      }),
    ).rejects.toBe(error);
    expect(onValidationFailed).not.toHaveBeenCalled();
    expect(onPagePrepared).not.toHaveBeenCalled();
  });

  it.each(["disk", "validation-shaped"])(
    "does not skip checkpoint publication errors: %s",
    async (kind) => {
      const { runWholePagePipeline, runtime } = await loadPipeline();
      const error =
        kind === "disk"
          ? Object.assign(new Error("disk write failed"), { code: "ENOSPC" })
          : new PreparedTranslationCheckpointValidationError(
              new Error("writer rejected data"),
            );
      const onPagePrepared = vi.fn(async () => {
        throw error;
      });
      const onPageFailed = vi.fn();
      const onPageSettled = vi.fn();
      await expect(
        runWholePagePipeline({
          ...basePipelineOptions(
            [makePage("page-a", "001.png"), makePage("page-b", "002.png")],
            [],
          ),
          onPagePrepared,
          onPageFailed,
          onPageSettled,
        }),
      ).rejects.toBe(error);
      expect(onPagePrepared).toHaveBeenCalledOnce();
      expect(onPageFailed).not.toHaveBeenCalled();
      expect(onPageSettled).not.toHaveBeenCalled();
      expect(runtime.disposeEndpoint).toHaveBeenCalledOnce();
    },
  );

  it.each(["write-failure", "cancelled"])(
    "stops before the next page when failed-page persistence is %s",
    async (kind) => {
      const pages = [
        makePage("page-a", "001.png"),
        makePage("page-b", "002.png"),
        makePage("page-c", "003.png"),
      ];
      const pipeline = await invalidCheckpointPipeline(pages);
      const controller = new AbortController();
      const onPageSettled = vi.fn();
      const run = pipeline.runWholePagePipeline({
        ...basePipelineOptions(pages, []),
        signal: controller.signal,
        onPagePrepared: async () => true,
        onPageSettled,
        onPageFailed: async () => {
          if (kind === "cancelled") controller.abort();
          else throw new Error("failed-page write failed");
        },
      });
      await expect(run).rejects.toThrow(
        kind === "cancelled" ? "Aborted" : "failed-page write failed",
      );
      expect(pipeline.requestTranslation).toHaveBeenCalledTimes(2);
      expect(onPageSettled).not.toHaveBeenCalled();
      expect(pipeline.runtime.disposeEndpoint).toHaveBeenCalledOnce();
    },
  );

  it("skips only an invalid checkpoint page without retrying or leaking its context", async () => {
    const pages = [
      makePage("page-a", "001.png"),
      makePage("page-b", "002.png"),
      makePage("page-c", "003.png"),
    ];
    const pipeline = await invalidCheckpointPipeline(pages);
    const onPagePrepared = vi.fn(async () => true);
    const onPageSettled = vi.fn();
    const onPageFailed = vi.fn(async () => {
      expect(onPageSettled).not.toHaveBeenCalled();
    });
    const onPageComplete = vi.fn(async () => true);
    const result = await pipeline.runWholePagePipeline({
      ...basePipelineOptions(pages, []),
      collectPageContext: true,
      workContext: makeEmptyWorkContext(),
      onPagePrepared,
      onPageSettled,
      onPageFailed,
      onPageComplete,
    });
    expect(result.pages.map(({ analysisStatus }) => analysisStatus)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(pipeline.requestTranslation).toHaveBeenCalledTimes(3);
    expect(onPagePrepared).toHaveBeenCalledTimes(2);
    expect(onPageFailed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "page-b", analysisStatus: "failed" }),
      expect.stringContaining("sourceDetectionIds"),
    );
    expect(onPageSettled.mock.calls).toEqual([
      ["page-b", true],
      ["page-a", false],
      ["page-c", false],
    ]);
    expect(onPageComplete).toHaveBeenCalledTimes(2);
    expect(pipeline.contexts).toEqual([[], ["page-a"], ["page-a"]]);
    expect(result.warnings.join("\n")).toContain("sourceDetectionIds");
    expect(result.pageLocalFailureIds).toEqual(["page-b"]);
    expect(pipeline.runtime.disposeEndpoint).toHaveBeenCalledOnce();
  });

  it("fails closed if a fresh page reaches preparation without an endpoint", () => {
    expect(() => requireTranslationEndpoint(undefined)).toThrow(
      "모델 endpoint가 시작되지 않았습니다",
    );
  });

  it("reuses an approved checkpoint without a model call and replays its context", async () => {
    const firstPage = makePage("page-a", "001.png");
    const secondPage = makePage("page-b", "002.png");
    let checkpoint: PreparedTranslationCheckpoint | undefined;
    const captureCheckpoint = vi.fn(
      async (value: PreparedTranslationCheckpoint) => {
        checkpoint = value;
        return true;
      },
    );
    const firstRequest = vi.fn().mockResolvedValue(
      translationWithPageContext("勇者", "용사", {
        visualSummary: "용사가 문을 연다.",
        glossary: [{ source: "勇者", target: "용사", category: "term" }],
        characters: [],
      }),
    );
    const firstPipeline = await loadPipeline({
      requestTranslation: firstRequest,
    });
    await firstPipeline.runWholePagePipeline({
      ...basePipelineOptions([firstPage], []),
      collectPageContext: true,
      workContext: makeEmptyWorkContext(),
      onPagePrepared: captureCheckpoint,
    });
    expect(captureCheckpoint).toHaveBeenCalledOnce();
    if (!checkpoint) throw new Error("checkpoint was not captured");

    const checkpointOnlyRequest = vi.fn();
    const checkpointOnly = await loadPipeline({
      requestTranslation: checkpointOnlyRequest,
    });
    const checkpointOnlyResult = await checkpointOnly.runWholePagePipeline({
      ...basePipelineOptions([firstPage], []),
      collectPageContext: true,
      workContext: makeEmptyWorkContext(),
      translationCheckpoints: new Map([[firstPage.id, checkpoint]]),
    });
    expect(checkpointOnlyRequest).not.toHaveBeenCalled();
    expect(checkpointOnly.runtime.startEndpointSession).not.toHaveBeenCalled();
    expect(checkpointOnly.runtime.disposeEndpoint).not.toHaveBeenCalled();
    expect(checkpointOnlyResult.pages[0]).toMatchObject({
      id: firstPage.id,
      analysisStatus: "completed",
    });

    const mixedRequest = vi.fn(
      async (_server: unknown, options: TranslationOptions) => {
        expect(options.pageId).toBe(secondPage.id);
        expect(options.workContext?.styleGuide.glossary).toEqual([
          expect.objectContaining({ source: "勇者", target: "용사" }),
        ]);
        expect(options.workContext?.storyMemory.pages).toEqual([
          expect.objectContaining({
            pageId: firstPage.id,
            visualSummary: "용사가 문을 연다.",
          }),
        ]);
        return successTranslationResult();
      },
    );
    const mixed = await loadPipeline({ requestTranslation: mixedRequest });
    await mixed.runWholePagePipeline({
      ...basePipelineOptions([firstPage, secondPage], []),
      collectPageContext: true,
      workContext: makeEmptyWorkContext(),
      translationCheckpoints: new Map([[firstPage.id, checkpoint]]),
      onPagePrepared: vi.fn(async () => true),
    });
    expect(mixedRequest).toHaveBeenCalledOnce();
    expect(mixed.runtime.startEndpointSession).toHaveBeenCalledOnce();
  });

  it("stops before the next page when checkpoint publication conflicts", async () => {
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(successTranslationResult());
    const { runWholePagePipeline, runtime } = await loadPipeline({
      requestTranslation,
    });
    await expect(
      runWholePagePipeline({
        ...basePipelineOptions(
          [makePage("page-a", "001.png"), makePage("page-b", "002.png")],
          [],
        ),
        onPagePrepared: vi.fn(async () => false),
      }),
    ).rejects.toThrow(/체크포인트를 저장하지 못했습니다/);
    expect(requestTranslation).toHaveBeenCalledOnce();
    expect(runtime.disposeEndpoint).toHaveBeenCalledOnce();
  });

  it("promotes an incompatible checkpoint to a safe fresh translation", async () => {
    const page = makePage("page-a", "001.png");
    const incompatible: PreparedTranslationCheckpoint = {
      schemaVersion: 1,
      pipelineContractVersion: "whole-page-prepared-v1",
      pageId: page.id,
      inputRevision: createPageRevision(page),
      sourceLanguage: "en",
      targetLanguage: "ko",
      blockMode: "auto",
      savedAt: "2026-01-01T00:00:00.000Z",
      translationDurationMs: 100,
      prepared: {
        kind: "ready",
        resultKind: "completed",
        blocks: [],
        warnings: [],
        detail: "stale",
      },
    };
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(successTranslationResult());
    const { runWholePagePipeline, runtime } = await loadPipeline({
      requestTranslation,
    });

    await runWholePagePipeline({
      ...basePipelineOptions([page], []),
      translationCheckpoints: new Map([[page.id, incompatible]]),
      onPagePrepared: vi.fn(async () => true),
    });

    expect(requestTranslation).toHaveBeenCalledOnce();
    expect(runtime.warn).toHaveBeenCalledWith(
      "Translation checkpoint promoted to restart",
      expect.objectContaining({
        pageId: page.id,
        reason: "language-pair-mismatch",
      }),
    );
  });
});

async function invalidCheckpointPipeline(pages: MangaPage[]) {
  vi.stubEnv("MANGA_TRANSLATOR_OCR_PIPELINE", "hayai");
  const contexts: string[][] = [];
  const requestTranslation = vi.fn(
    async (_server: unknown, options: TranslationOptions) => {
      contexts.push(
        options.workContext?.storyMemory.pages.map(({ pageId }) => pageId) ??
          [],
      );
      return translationWithPageContext("勇者", "용사", {
        visualSummary: options.pageId,
        glossary: [],
        characters: [],
      });
    },
  );
  const pipeline = await loadPipeline({
    requestTranslation,
    ocrHintsByImagePath: new Map([
      [
        pages[1].imagePath,
        {
          hints: [],
          diagnostics: [],
          noTextDetected: false,
          effectReviewRegions: [
            {
              id: "FX-invalid",
              bbox: { x: 500, y: 600, w: 120, h: 150 },
              detectorConfidence: 0.94,
              sourceDetectionIds: [""],
            },
          ],
        },
      ],
    ]),
  });
  return { ...pipeline, requestTranslation, contexts };
}
