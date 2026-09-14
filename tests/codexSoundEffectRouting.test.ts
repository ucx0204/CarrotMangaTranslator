import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { expect, it, vi } from "vitest";
import {
  CodexImageEditError,
  editTranslatedPageWithCodex,
} from "../src/main/codexImageEditing";
import { confirmSoundEffectTextReview } from "../src/main/application/soundEffectTextReview";
import { withApprovedImageRedactions } from "../src/main/imageRedactionContext";
import type { JobEvent } from "../src/shared/jobTypes";
import {
  runSoundEffectTranslationJob,
  type SoundEffectTranslationJobRunnerDependencies,
} from "../src/main/jobs/soundEffectTranslationJobRunner";
import { createDefaultWholePagePipelineDependencies } from "../src/main/pipeline/wholePagePipelinePorts";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { resolveCodexTypesettingOptions } from "../src/shared/codexTypesettingDefaults";
import { createSoundEffectReviewPageRevision } from "../src/shared/pageRevision";
import type { SoundEffectTranslationJobInput } from "../src/main/jobs/translationJobTypes";
import { applyResolvedSoundEffectEntries } from "../src/main/libraryStore/librarySoundEffectMutations";
import { makeChapter } from "./unifiedInpaintingUiFixtures";
import { refreshSoundEffectTarget } from "../src/main/jobs/soundEffectTranslationPreparation";
import { resolveStoredSoundEffectTargets } from "../src/main/jobs/soundEffectTranslationTargets";
vi.mock("electron", () => ({ app: { isPackaged: false } }));
function fixture(pageCount = 1, regionCount = 1) {
  let chapter = makeChapter();
  const page = chapter.pages[0];
  page.soundEffectReview = {
    contractVersion: 3,
    producer: "hayai-regions-v1",
    regions: Array.from({ length: regionCount }, (_, index) => ({
      id: `FX00${index + 1}`,
      bbox: { x: 100 + index * 200, y: 100, w: 100, h: 100 },
      detectorConfidence: 1,
    })),
    resolvedRegions: [],
    regionOverrides: [],
    manualRegions: [],
  };
  chapter.pages = Array.from({ length: pageCount }, (_, index) => ({
    ...structuredClone(page),
    id: `${page.id}-${index}`,
  }));
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = "gemma";
  const pipeline = createDefaultWholePagePipelineDependencies();
  pipeline.settings.getAppSettings = async () => settings;
  pipeline.runtime.isModelCached = () => true;
  const dispose = vi.fn(async () => {});
  pipeline.runtime.startEndpointSession = vi.fn(async () => ({
    handle: {
      baseUrl: "http://localhost",
      model: "gemma",
      child: null,
      startedByScript: false,
      provider: "openai-api" as const,
    },
    dispose,
  }));
  const input: SoundEffectTranslationJobInput = {
    id: "job",
    context: {
      jobs: new ActiveJobStore(),
      getMainWindow: () => null,
      decodeImage: async () => null,
    },
    abortController: new AbortController(),
    emit: vi.fn((event) => confirmReview(event)),
    registerResourceCleanup: () => {},
    request: {
      chapterId: chapter.id,
      targets: chapter.pages.map((page) => ({
        pageId: page.id,
        pageRevision: createSoundEffectReviewPageRevision(page),
      })),
      inpaintAfterTranslation: true,
      codexTypesetting: resolveCodexTypesettingOptions(undefined, "ko"),
    },
    state: {
      chapter: null,
      createdBlocksByPage: [],
      translatedRegionCount: 0,
      warnings: [],
    },
  };
  const editImages = vi.fn<
    NonNullable<SoundEffectTranslationJobRunnerDependencies["editImages"]>
  >(async ({ page }) => ({ ...page, inpaintedImagePath: "clean.png" }));
  const dependencies: SoundEffectTranslationJobRunnerDependencies = {
    saveImageRecovery: vi.fn(async () => {}),
    saveImages: vi.fn<
      NonNullable<SoundEffectTranslationJobRunnerDependencies["saveImages"]>
    >(async (_chapterId, pages) => {
      chapter = {
        ...chapter,
        pages: chapter.pages.map(
          (page) => pages.find((next) => next.id === page.id) ?? page,
        ),
      };
      return structuredClone(chapter);
    }),
    createPipelineDependencies: () => pipeline,
    openChapter: async () => structuredClone(chapter),
    getRunPaths: async () =>
      ({ runDir: "fixture/run" }) as Awaited<
        ReturnType<SoundEffectTranslationJobRunnerDependencies["getRunPaths"]>
      >,
    resolveWorkContext: async () =>
      ({
        workId: "work",
        workTitle: "work",
        styleGuide: {},
        storyMemory: {},
      }) as Awaited<
        ReturnType<
          SoundEffectTranslationJobRunnerDependencies["resolveWorkContext"]
        >
      >,
    translateRegions: vi.fn<
      NonNullable<
        SoundEffectTranslationJobRunnerDependencies["translateRegions"]
      >
    >(async ({ run, target }) => {
      expect(run.baseOptions.modelProvider).toBe("gemma");
      return {
        items: target.regions.map((region) => ({
          regionId: region.id,
          verdict: "sound" as const,
          confirmedSource: "サッ",
          translation: "슥",
          confidence: 1,
        })),
        warnings: [],
      };
    }),
    editImages,
    inpaintCreatedBlocks: vi.fn(),
    appendResolvedBlocks: vi.fn(
      async (_chapterId, _pageId, _revision, entries, image) => {
        chapter = {
          ...chapter,
          pages: chapter.pages.map((page) =>
            page.id === _pageId
              ? {
                  ...applyResolvedSoundEffectEntries(page, entries, "now"),
                  ...image,
                }
              : page,
          ),
        };
        return structuredClone(chapter);
      },
    ),
  };
  return { input, dependencies, editImages, settings, dispose };
}

function confirmReview(event: JobEvent) {
  const review = event.soundEffectTextReview;
  if (!review) return;
  confirmSoundEffectTextReview({
    jobId: event.id,
    sessionId: review.sessionId,
    pages: review.pages.map((page) => ({
      pageId: page.pageId,
      translations: page.review.regions.map((region) => ({
        regionId: region.id,
        text: region.translatedText,
      })),
    })),
  });
}

it.each([true, false])(
  "refreshes SFX coordinates after handoff and fails if chapter state is missing: %s",
  async (hasChapter) => {
    const f = fixture();
    const chapter = await f.dependencies.openChapter(f.input.request.chapterId);
    const initial = resolveStoredSoundEffectTargets(
      chapter,
      f.input.request,
    )[0];
    f.input.state.chapter = hasChapter ? chapter : null;
    f.input.context.jobs.start({
      id: f.input.id,
      kind: "sound-effect-translation",
      resources: [],
      abortController: f.input.abortController,
    });
    const handoffs = f.input.context.jobs.pageHandoffs;
    const unsubscribe = handoffs.subscribe(() => {
      for (const page of handoffs.activities)
        if (page.requestId && page.phase === "finishing-edits")
          handoffs.respond({ requestId: page.requestId });
    });
    const latest = structuredClone(chapter);
    if (!latest.pages[0].soundEffectReview)
      throw new Error("Missing SFX review fixture");
    latest.pages[0].soundEffectReview.regions[0].bbox.x = 321;
    try {
      const result = refreshSoundEffectTarget(
        f.input,
        initial,
        async () => latest,
      );
      if (!hasChapter) await expect(result).rejects.toThrow("화");
      else expect((await result).regions[0].bbox.x).toBe(321);
    } finally {
      unsubscribe();
      f.input.context.jobs.clearIfCurrent(f.input.id);
    }
  },
);

it("waits for the whole batch, then preserves edited text, boxes, and added blocks", async () => {
  const f = fixture(2);
  let reviewEvent: JobEvent | undefined;
  f.input.emit = (event) => {
    if (event.soundEffectTextReview) reviewEvent = event;
  };
  f.editImages.mockImplementation((input) =>
    editTranslatedPageWithCodex({
      ...input,
      output: "text",
      eraseOriginal: false,
    }),
  );
  const running = runSoundEffectTranslationJob(f.input, f.dependencies);
  await vi.waitFor(() =>
    expect(reviewEvent?.soundEffectTextReview?.pages).toHaveLength(2),
  );
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(f.editImages).not.toHaveBeenCalled();
  expect(f.dependencies.appendResolvedBlocks).not.toHaveBeenCalled();
  const review = reviewEvent?.soundEffectTextReview;
  if (!review) throw new Error("Missing batch review");
  confirmSoundEffectTextReview({
    jobId: f.input.id,
    sessionId: review.sessionId,
    pages: review.pages.map((page, index) => {
      const original = page.review.regions[0];
      return {
        pageId: page.pageId,
        translations: [
          {
            regionId: original.id,
            text: `수정 ${index}`,
            sourceText: "ササッ",
            sourceBbox: { x: 150, y: 200, w: 250, h: 300 },
          },
          {
            regionId: `added-${index}`,
            parentRegionId: original.id,
            text: "추가",
            sourceText: "",
            sourceBbox: { x: 500, y: 100, w: 100, h: 100 },
          },
        ],
      };
    }),
  });
  const result = await running;
  expect(result.status).toBe("completed");
  expect(
    result.createdBlocksByPage.every((page) => page.blockIds.length === 2),
  ).toBe(true);
  if (!result.chapter) throw new Error("Missing saved chapter");
  for (const [index, page] of result.chapter.pages.entries()) {
    expect(
      page.blocks.some(
        (block) =>
          block.translatedText === `수정 ${index}` &&
          block.bbox.x === 150 &&
          block.sourceText === "ササッ",
      ),
    ).toBe(true);
    expect(
      page.blocks.some(
        (block) =>
          block.id === `added-${index}` && block.translatedText === "추가",
      ),
    ).toBe(true);
  }
});

it("cancels a pending review without image calls or committing unconfirmed edits", async () => {
  const f = fixture();
  f.input.emit = (event) => {
    if (event.soundEffectTextReview) f.input.abortController.abort();
  };
  await expect(
    runSoundEffectTranslationJob(f.input, f.dependencies),
  ).rejects.toThrow();
  expect(f.editImages).not.toHaveBeenCalled();
  expect(f.dependencies.appendResolvedBlocks).not.toHaveBeenCalled();
});

it("leaves an excluded candidate pending without creating its translated block", async () => {
  const f = fixture(1, 2);
  f.editImages.mockImplementation((input) =>
    editTranslatedPageWithCodex({
      ...input,
      output: "text",
      eraseOriginal: false,
    }),
  );
  f.input.emit = (event) => {
    const review = event.soundEffectTextReview;
    if (!review) return;
    confirmSoundEffectTextReview({
      jobId: event.id,
      sessionId: review.sessionId,
      pages: review.pages.map((page) => ({
        pageId: page.pageId,
        translations: page.review.regions.map((region, index) => ({
          regionId: region.id,
          text: region.translatedText,
          excluded: index === 0,
        })),
      })),
    });
  };
  const result = await runSoundEffectTranslationJob(f.input, f.dependencies);
  expect(result.status).toBe("partial");
  expect(result.remainingRegionCount).toBe(1);
  expect(result.createdBlocksByPage[0].blockIds).toHaveLength(1);
  const append = vi.mocked(f.dependencies.appendResolvedBlocks).mock.calls[0];
  expect(append[3].map((entry) => entry.regionId)).toEqual(["FX002"]);
  expect(
    result.chapter?.pages[0].soundEffectReview?.resolvedRegions.map(
      (region) => region.regionId,
    ),
  ).toEqual(["FX002"]);
});

it("checks reviewed boxes against the approved redaction mask before image generation", async () => {
  const f = fixture();
  f.input.emit = (event) => {
    const review = event.soundEffectTextReview;
    if (!review) return;
    confirmSoundEffectTextReview({
      jobId: event.id,
      sessionId: review.sessionId,
      pages: review.pages.map((page) => ({
        pageId: page.pageId,
        translations: page.review.regions.map((region) => ({
          regionId: region.id,
          text: "수정",
          sourceBbox: { x: 500, y: 500, w: 100, h: 100 },
        })),
      })),
    });
  };
  f.editImages.mockImplementation((input) =>
    withApprovedImageRedactions(
      [
        {
          ...input.page,
          fingerprint: "test",
          strokes: [
            {
              shape: "rectangle",
              size: 1,
              points: [
                { x: input.page.width * 0.5, y: input.page.height * 0.5 },
                { x: input.page.width * 0.6, y: input.page.height * 0.6 },
              ],
            },
          ],
        },
      ],
      () =>
        editTranslatedPageWithCodex({
          ...input,
          output: "text",
          eraseOriginal: false,
        }),
    ),
  );
  await expect(
    runSoundEffectTranslationJob(f.input, f.dependencies),
  ).rejects.toThrow("가리기와 겹치는");
});
it("keeps completed source erasure and translated blocks when subsequent lettering fails", async () => {
  const f = fixture();
  f.editImages.mockImplementation(async ({ page }) => {
    throw new CodexImageEditError(
      {
        ...page,
        inpaintedImagePath: "completed-clean.png",
        inpaintMaskPath: "completed-mask.png",
      },
      new Error("lettering unavailable"),
    );
  });
  await expect(
    runSoundEffectTranslationJob(f.input, f.dependencies),
  ).rejects.toThrow("lettering unavailable");
  expect(f.input.state.translatedRegionCount).toBe(1);
  expect(f.dependencies.saveImages).toHaveBeenCalledWith(
    expect.any(String),
    [
      expect.objectContaining({
        inpaintedImagePath: "completed-clean.png",
        inpaintMaskPath: "completed-mask.png",
      }),
    ],
    expect.any(Object),
  );
});
it("translates with the configured engine, saves approved text before generating and checkpointing images", async () => {
  const f = fixture();
  const before = structuredClone(f.settings);
  const result = await runSoundEffectTranslationJob(f.input, f.dependencies);
  expect(result.status).toBe("completed");
  expect(f.editImages).toHaveBeenCalledOnce();
  expect(f.editImages.mock.calls[0][0].page.blocks[0].translatedText).toBe(
    "슥",
  );
  expect(f.dependencies.inpaintCreatedBlocks).not.toHaveBeenCalled();
  expect(f.dependencies.saveImages).toHaveBeenCalledWith(
    expect.any(String),
    [expect.objectContaining({ inpaintedImagePath: "clean.png" })],
    expect.any(Object),
  );
  expect(
    vi.mocked(f.dependencies.appendResolvedBlocks).mock.invocationCallOrder[0],
  ).toBeLessThan(f.editImages.mock.invocationCallOrder[0]);
  expect(f.settings).toEqual(before);
  expect(f.dispose).toHaveBeenCalledOnce();
});
it("does not retry image failure and preserves translated text for inspection", async () => {
  const f = fixture();
  f.editImages.mockRejectedValue(new Error("image failed"));
  await expect(
    runSoundEffectTranslationJob(f.input, f.dependencies),
  ).rejects.toThrow("image failed");
  expect(f.editImages).toHaveBeenCalledOnce();
  expect(f.input.state.translatedRegionCount).toBe(1);
});
it("preserves confirmed text if the image adapter is unavailable", async () => {
  const f = fixture();
  f.dependencies.editImages = undefined;
  await expect(
    runSoundEffectTranslationJob(f.input, f.dependencies),
  ).rejects.toThrow("이미지 저장 서비스를 사용할 수 없습니다");
  expect(f.input.state.translatedRegionCount).toBe(1);
  expect(f.dependencies.appendResolvedBlocks).toHaveBeenCalledOnce();
});
it("preserves confirmed text but does not commit a late image result after cancellation", async () => {
  const f = fixture();
  f.editImages.mockImplementation(async ({ page }) => {
    f.input.abortController.abort();
    return { ...page, inpaintedImagePath: "late-image.png" };
  });
  await expect(
    runSoundEffectTranslationJob(f.input, f.dependencies),
  ).rejects.toThrow();
  expect(f.dependencies.appendResolvedBlocks).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    expect.any(String),
    [
      expect.objectContaining({
        block: expect.objectContaining({ translatedText: "슥" }),
      }),
    ],
  );
});

it("preserves confirmed edits on every page when the first image request fails", async () => {
  const f = fixture(2);
  f.input.emit = (event) => {
    const review = event.soundEffectTextReview;
    if (!review) return;
    confirmSoundEffectTextReview({
      jobId: event.id,
      sessionId: review.sessionId,
      pages: review.pages.map((page) => ({
        pageId: page.pageId,
        translations: page.review.regions.flatMap((region) => [
          {
            regionId: region.id,
            text: "확정된 번역",
            sourceText: "修正",
            sourceBbox: { x: 110, y: 120, w: 130, h: 140 },
          },
          {
            regionId: `new-${page.pageId}`,
            parentRegionId: region.id,
            text: "추가됨",
            sourceText: "",
            sourceBbox: { x: 400, y: 300, w: 200, h: 100 },
          },
        ]),
      })),
    });
  };
  f.editImages.mockImplementationOnce(async ({ page }) => {
    throw new CodexImageEditError(page, new Error("image unavailable"));
  });
  await expect(
    runSoundEffectTranslationJob(f.input, f.dependencies),
  ).rejects.toThrow("image unavailable");
  expect(f.editImages).toHaveBeenCalledTimes(2);
  expect(f.input.state.chapter?.pages[1].inpaintedImagePath).toBe("clean.png");
  expect(f.dependencies.appendResolvedBlocks).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(f.dependencies.appendResolvedBlocks).mock
    .calls) {
    expect(call[3]).toMatchObject([
      {
        block: {
          translatedText: "확정된 번역",
          sourceText: "修正",
          bbox: { x: 110, y: 120, w: 130, h: 140 },
        },
        additionalBlocks: [{ translatedText: "추가됨" }],
      },
    ]);
  }
});

it("keeps text-only SFX on the same durable text path without requesting an image", async () => {
  const f = fixture();
  f.input.request.codexTypesetting = undefined;
  f.input.request.autoFontMatching = false;
  f.input.request.inpaintAfterTranslation = false;
  const result = await runSoundEffectTranslationJob(f.input, f.dependencies);
  expect(result.status).toBe("completed");
  expect(f.dependencies.appendResolvedBlocks).toHaveBeenCalledOnce();
  expect(f.dependencies.editImages).not.toHaveBeenCalled();
});
