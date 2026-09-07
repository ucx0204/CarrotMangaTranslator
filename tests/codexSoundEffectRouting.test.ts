import { expect, it, vi } from "vitest";
import { CodexImageEditError } from "../src/main/codexImageEditing";
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
vi.mock("electron", () => ({ app: { isPackaged: false } }));
function fixture() {
  let chapter = makeChapter();
  const page = chapter.pages[0];
  page.soundEffectReview = {
    contractVersion: 3,
    producer: "hayai-regions-v1",
    regions: [
      {
        id: "FX001",
        bbox: { x: 100, y: 100, w: 100, h: 100 },
        detectorConfidence: 1,
      },
    ],
    resolvedRegions: [],
    regionOverrides: [],
    manualRegions: [],
  };
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
      jobs: {} as SoundEffectTranslationJobInput["context"]["jobs"],
      getMainWindow: () => null,
      decodeImage: async () => null,
    },
    abortController: new AbortController(),
    emit: vi.fn(),
    registerResourceCleanup: () => {},
    request: {
      chapterId: chapter.id,
      targets: [
        {
          pageId: page.id,
          pageRevision: createSoundEffectReviewPageRevision(page),
        },
      ],
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
    translateRegions: vi.fn(async ({ run }) => {
      expect(run.baseOptions.modelProvider).toBe("gemma");
      return {
        items: [
          {
            regionId: "FX001",
            verdict: "sound" as const,
            confirmedSource: "サッ",
            translation: "슥",
            confidence: 1,
          },
        ],
        warnings: [],
      };
    }),
    editImages,
    inpaintCreatedBlocks: vi.fn(),
    appendResolvedBlocks: vi.fn(
      async (_chapterId, _pageId, _revision, entries, image) => {
        chapter = {
          ...chapter,
          pages: [
            {
              ...applyResolvedSoundEffectEntries(
                chapter.pages[0],
                entries,
                "now",
              ),
              ...image,
            },
          ],
        };
        return structuredClone(chapter);
      },
    ),
  };
  return { input, dependencies, editImages, settings, dispose };
}
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
  expect(f.dependencies.appendResolvedBlocks).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    expect.any(String),
    expect.any(Array),
    expect.objectContaining({
      inpaintedImagePath: "completed-clean.png",
      inpaintMaskPath: "completed-mask.png",
    }),
  );
});
it("translates with the configured engine, then edits images once and commits both together", async () => {
  const f = fixture();
  const before = structuredClone(f.settings);
  const result = await runSoundEffectTranslationJob(f.input, f.dependencies);
  expect(result.status).toBe("completed");
  expect(f.editImages).toHaveBeenCalledOnce();
  expect(f.editImages.mock.calls[0][0].page.blocks[0].translatedText).toBe(
    "슥",
  );
  expect(f.dependencies.inpaintCreatedBlocks).not.toHaveBeenCalled();
  expect(f.dependencies.appendResolvedBlocks).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    expect.any(String),
    expect.any(Array),
    expect.objectContaining({ inpaintedImagePath: "clean.png" }),
  );
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
it("does not commit a late image result after cancellation", async () => {
  const f = fixture();
  f.editImages.mockImplementation(async ({ page }) => {
    f.input.abortController.abort();
    return page;
  });
  await expect(
    runSoundEffectTranslationJob(f.input, f.dependencies),
  ).rejects.toThrow();
  expect(f.dependencies.appendResolvedBlocks).not.toHaveBeenCalled();
});
