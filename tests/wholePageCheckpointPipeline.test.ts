import { afterEach, describe, expect, it, vi } from "vitest";
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
import { requireTranslationEndpoint } from "../src/main/pipeline/wholePageCheckpointFlow";

afterEach(async () => {
  vi.clearAllMocks();
  await cleanupPipelineTempDirs();
});

describe("whole page translation checkpoints", () => {
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
