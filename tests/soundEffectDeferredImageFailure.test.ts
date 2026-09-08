import { expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  handleSoundEffectTranslationJobError,
  runSoundEffectTranslationJob,
  type SoundEffectTranslationJobRunnerDependencies,
} from "../src/main/jobs/soundEffectTranslationJobRunner";
import type { SoundEffectTranslationJobInput } from "../src/main/jobs/translationJobTypes";
import { applyResolvedSoundEffectEntries } from "../src/main/libraryStore/librarySoundEffectMutations";
import { createDefaultWholePagePipelineDependencies } from "../src/main/pipeline/wholePagePipelinePorts";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { resolveCodexTypesettingOptions } from "../src/shared/codexTypesettingDefaults";
import type { MangaPage } from "../src/shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../src/shared/pageRevision";
import { builtIn } from "./helpers/automaticFontMatchingV2Fixtures";
import { makeEmptyWorkContext } from "./helpers/wholePagePipelineHarness";
import { makeChapter } from "./unifiedInpaintingUiFixtures";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

it("saves both pretranslated pages after the first deferred image failure and reports partial", async () => {
  const f = fixture();
  const error = await runSoundEffectTranslationJob(
    f.input,
    f.dependencies,
  ).catch((failure: unknown) => failure);
  expect(error).toBe(f.imageFailure);
  expect(f.order).toEqual([
    "translate:page-1",
    "translate:page-2",
    "endpoint:dispose",
    "font:page-1",
    "image:page-1",
    "save:page-1",
    "font:page-2",
    "save:page-2",
    "font:dispose",
  ]);
  expect(f.saved.map((page) => page.blocks[0]?.translatedText)).toEqual([
    "슥",
    "쾅",
  ]);
  expect(
    f.saved.map((page) => page.soundEffectReview?.resolvedRegions),
  ).toEqual(
    f.saved.map((page) => [
      expect.objectContaining({
        regionId: "FX001",
        blockId: page.blocks[0].id,
      }),
    ]),
  );
  expect(f.dependencies.editImages).toHaveBeenCalledOnce();
  expect(f.dependencies.inpaintCreatedBlocks).not.toHaveBeenCalled();

  const result = await handleSoundEffectTranslationJobError({
    ...f.input,
    dependencies: f.dependencies,
    error,
  });
  expect(result).toMatchObject({
    status: "partial",
    error: f.imageFailure.message,
    translatedRegionCount: 2,
    remainingRegionCount: 0,
    createdBlocksByPage: f.saved.map((page) => ({
      pageId: page.id,
      blockIds: [page.blocks[0].id],
    })),
  });
  expect(result.chapter?.pages).toEqual(f.saved);
  expect(f.input.emit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "partial",
      detail: f.imageFailure.message,
    }),
  );
});

it.each([
  { phase: "before-finalization", pageId: "page-1" },
  { phase: "font", pageId: "page-1" },
  { phase: "font", pageId: "page-2" },
  { phase: "image", pageId: "page-1" },
  { phase: "image", pageId: "page-2" },
  { phase: "after-save", pageId: "page-1" },
  { phase: "after-save", pageId: "page-2" },
] as const)(
  "preserves both completed translations exactly once when cancelled at $phase on $pageId",
  async (cancelAt) => {
    const f = fixture(cancelAt);
    const result = await runSoundEffectTranslationJob(
      f.input,
      f.dependencies,
    ).catch((error: unknown) => {
      expect(f.input.abortController.signal.aborted).toBe(true);
      return handleSoundEffectTranslationJobError({
        ...f.input,
        dependencies: f.dependencies,
        error,
      });
    });

    expect(result.status).toBe("cancelled");
    expect(f.input.abortController.signal.aborted).toBe(true);
    expect(f.order.slice(0, 3)).toEqual([
      "translate:page-1",
      "translate:page-2",
      "endpoint:dispose",
    ]);
    expect(f.saved.map((page) => page.id)).toEqual(["page-1", "page-2"]);
    expect(
      f.saved.map((page) => page.blocks.map((block) => block.translatedText)),
    ).toEqual([["슥"], ["쾅"]]);
    expect(
      f.saved.map((page) => page.soundEffectReview?.resolvedRegions),
    ).toEqual(
      f.saved.map((page) => [
        {
          regionId: "FX001",
          blockId: page.blocks[0].id,
          resolvedAt: "saved",
        },
      ]),
    );
    expect(f.input.state.translatedRegionCount).toBe(2);
    expect(f.input.state.createdBlocksByPage).toEqual(
      f.saved.map((page) => ({
        pageId: page.id,
        blockIds: [page.blocks[0].id],
      })),
    );
    const cancelIndex = f.order.findIndex((step) => step.startsWith("cancel:"));
    expect(cancelIndex).toBeGreaterThan(2);
    expect(
      f.order
        .slice(cancelIndex + 1)
        .filter(
          (step) => step.startsWith("font:page-") || step.startsWith("image:"),
        ),
    ).toEqual([]);
    expect(f.order.at(-1)).toBe("font:dispose");
    expect(f.dependencies.inpaintCreatedBlocks).not.toHaveBeenCalled();
  },
);

type CancellationPoint = {
  phase: "before-finalization" | "font" | "image" | "after-save";
  pageId: string;
};

function fixture(cancelAt?: CancellationPoint) {
  let chapter = makeChapter();
  chapter.pages = [1, 2].map((index) => ({
    ...structuredClone(chapter.pages[0]),
    id: `page-${index}`,
    name: `page-${index}.png`,
    imagePath: `page-${index}.png`,
    soundEffectReview: {
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
    },
  }));
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  const order: string[] = [];
  const saved: MangaPage[] = [];
  const imageFailure = new Error("first page lettering provider failed");
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = "gemma";
  const pipeline = createDefaultWholePagePipelineDependencies();
  pipeline.settings.getAppSettings = async () => settings;
  pipeline.diagnostics = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  pipeline.runtime.isModelCached = () => true;
  pipeline.runtime.startEndpointSession = async () => ({
    handle: {
      baseUrl: "http://127.0.0.1:1",
      child: null,
      startedByScript: false,
    },
    dispose: async () => {
      order.push("endpoint:dispose");
      cancel("before-finalization", "page-1");
    },
  });
  pipeline.fontMatching = {
    loadCandidates: () => [builtIn("jua")],
    loadProfile: async () => null,
    pageInference: {
      inferPage: async ({ page, signal }) => {
        order.push(`font:${page.id}`);
        cancel("font", page.id);
        signal?.throwIfAborted();
        return { pixelInferenceByBlockId: new Map() };
      },
      dispose: async () => {
        order.push("font:dispose");
      },
    },
  };
  const input: SoundEffectTranslationJobInput = {
    id: "deferred-sfx",
    context: {
      jobs: new ActiveJobStore(),
      getMainWindow: () => null,
      decodeImage: async () => null,
    },
    abortController: new AbortController(),
    emit: vi.fn(),
    registerResourceCleanup: () => {},
    request: {
      chapterId: chapter.id,
      targets: chapter.pages.map((page) => ({
        pageId: page.id,
        pageRevision: createSoundEffectReviewPageRevision(page),
      })),
      inpaintAfterTranslation: true,
      autoFontMatching: true,
      codexTypesetting: resolveCodexTypesettingOptions(undefined, "ko"),
    },
    state: {
      chapter: null,
      createdBlocksByPage: [],
      translatedRegionCount: 0,
      warnings: [],
    },
  };
  const dependencies: SoundEffectTranslationJobRunnerDependencies = {
    createPipelineDependencies: () => pipeline,
    openChapter: async () => structuredClone(chapter),
    getRunPaths: async () => ({ chapterDir: "fixture", runDir: "fixture/run" }),
    resolveWorkContext: async () => ({
      ...makeEmptyWorkContext(),
      workTitle: "test",
    }),
    translateRegions: async ({ target, run }) => {
      expect(run.baseOptions.autoFontMatching).toBe(true);
      order.push(`translate:${target.page.id}`);
      return {
        items: [
          {
            regionId: "FX001",
            verdict: "sound",
            confirmedSource: target.page.id === "page-1" ? "サッ" : "ドン",
            translation: target.page.id === "page-1" ? "슥" : "쾅",
            confidence: 1,
          },
        ],
        warnings: [],
      };
    },
    editImages: vi.fn(async ({ page, signal }) => {
      order.push(`image:${page.id}`);
      cancel("image", page.id);
      signal.throwIfAborted();
      if (cancelAt) return page;
      throw imageFailure;
    }),
    inpaintCreatedBlocks: vi.fn(),
    appendResolvedBlocks: async (
      _chapterId,
      pageId,
      revision,
      entries,
      image,
    ) => {
      const page = chapter.pages.find((candidate) => candidate.id === pageId);
      if (!page) throw new Error(`Missing fixture page ${pageId}`);
      expect(revision).toBe(createSoundEffectReviewPageRevision(page));
      expect(image).toBeUndefined();
      const updated = {
        ...page,
        ...applyResolvedSoundEffectEntries(page, entries, "saved"),
      };
      chapter = {
        ...chapter,
        pages: chapter.pages.map((candidate) =>
          candidate.id === pageId ? updated : candidate,
        ),
      };
      saved.push(structuredClone(updated));
      order.push(`save:${pageId}`);
      cancel("after-save", pageId);
      return structuredClone(chapter);
    },
  };
  return { input, dependencies, order, saved, imageFailure };

  function cancel(phase: CancellationPoint["phase"], pageId: string) {
    if (cancelAt?.phase !== phase || cancelAt.pageId !== pageId) return;
    order.push(`cancel:${phase}:${pageId}`);
    input.abortController.abort();
  }
}
