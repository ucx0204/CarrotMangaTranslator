import { describe, expect, it, vi } from "vitest";
import {
  createCodexSoundEffectRunner,
  runCodexSoundEffectTranslation,
} from "../src/main/jobs/codexSoundEffectTranslation";
import { applyResolvedSoundEffectEntries } from "../src/main/libraryStore/librarySoundEffectMutations";
import { createSoundEffectReviewPageRevision } from "../src/shared/pageRevision";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { SoundEffectTranslationJobInput } from "../src/main/jobs/translationJobTypes";
import type { PipelineOptions } from "../src/main/pipeline/types";
import type { JobEvent } from "../src/shared/jobTypes";
import { makeChapter, makeBlock } from "./unifiedInpaintingUiFixtures";
import { makePngImage } from "./helpers/imageFixtures";
import { runSoundEffectTranslationJob } from "../src/main/jobs/soundEffectTranslationJobRunner";
import { createDefaultWholePagePipelineDependencies } from "../src/main/pipeline/wholePagePipelinePorts";
import { resolveCodexTypesettingOptions } from "../src/shared/codexTypesettingDefaults";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

type Dependencies = NonNullable<
  Parameters<typeof runCodexSoundEffectTranslation>[2]
>;
function fixture() {
  let stored = makeChapter();
  stored.pages[0].blocks = [makeBlock()];
  stored.pages[0].soundEffectReview = {
    contractVersion: 3,
    producer: "hayai-regions-v1",
    regions: [0, 1].map((index) => ({
      id: `effect-${index}`,
      bbox: { x: 100 + index * 400, y: 100, w: 200, h: 200 },
      detectorConfidence: 1,
    })),
    resolvedRegions: [],
    regionOverrides: [],
    manualRegions: [],
  };
  const original = structuredClone(stored);
  const events: JobEvent[] = [];
  const input: SoundEffectTranslationJobInput = {
    id: "sfx",
    context: {
      jobs: {} as SoundEffectTranslationJobInput["context"]["jobs"],
      getMainWindow: () => null,
      decodeImage: async () => null,
    },
    request: {
      chapterId: stored.id,
      targets: [
        {
          pageId: stored.pages[0].id,
          pageRevision: createSoundEffectReviewPageRevision(stored.pages[0]),
        },
      ],
      inpaintAfterTranslation: true,
    },
    abortController: new AbortController(),
    emit: (event) => events.push(event),
    registerResourceCleanup: () => {},
    state: {
      chapter: null,
      createdBlocksByPage: [],
      translatedRegionCount: 0,
      warnings: [],
    },
  };
  let cropIndex = 0;
  const dataUrl = `data:image/png;base64,${makePngImage(2, 2).toString("base64")}`;
  const dependencies: Dependencies = {
    open: vi.fn(async () => structuredClone(stored)),
    paths: vi.fn(
      async () =>
        ({ chapterDir: "fixture", runDir: "fixture/run" }) as Awaited<
          ReturnType<Dependencies["paths"]>
        >,
    ),
    context: vi.fn(
      async (): ReturnType<Dependencies["context"]> => ({
        workId: stored.workId,
        workTitle: "Fixture",
        styleGuide: {
          schemaVersion: 1,
          workId: stored.workId,
          glossary: [],
          characters: [],
          rules: {
            honorifics: "adapt",
            sfxMode: "translate",
            defaultTone: "natural_korean",
          },
          createdAt: "",
          updatedAt: "",
        },
        storyMemory: {
          schemaVersion: 1,
          workId: stored.workId,
          chapterId: stored.id,
          pages: [],
          updatedAt: "",
        },
      }),
    ),
    crop: vi.fn(async (page) => ({
      cropPage: {
        ...page,
        id: `crop-${cropIndex++}`,
        name: "effect",
        blocks: [],
        width: 200,
        height: 200,
        imagePath: "crop.png",
      },
      cropRect: { x: 100, y: 160, w: 200, h: 320 },
    })),
    artwork: vi.fn(async ({ crop }) => `${crop.id}-background.png`),
    append: vi.fn(async (_chapter, _page, revision, entries, image) => {
      expect(revision).toBe(
        createSoundEffectReviewPageRevision(stored.pages[0]),
      );
      stored = {
        ...stored,
        pages: [
          {
            ...applyResolvedSoundEffectEntries(stored.pages[0], entries, "now"),
            ...(image ?? {}),
          },
        ],
      };
      return structuredClone(stored);
    }),
    run: vi.fn(async (options) => {
      const pages = [];
      for (const [index, crop] of options.pages.entries()) {
        options.signal.throwIfAborted();
        const block = {
          ...makeBlock(),
          id: `translated-${index}`,
          sourceText: "ドン",
          translatedText: "쿵",
          generatedLettering: {
            version: 1 as const,
            dataUrl,
            sourceText: "ドン",
            translatedText: "쿵",
          },
        };
        const page = {
          ...crop,
          analysisStatus: "completed" as const,
          blocks: [block],
          inpaintedImagePath: `${crop.id}-clean.png`,
        };
        await options.onPageComplete?.(page);
        options.emit({
          id: input.id,
          kind: "gemma-analysis",
          status: "running",
          codexProgress: {
            stage: "typesetting",
            step: "saving",
            completed: index + 1,
            total: options.pages.length,
            page: index + 1,
          },
        });
        pages.push(page);
      }
      return { pages, warnings: [] };
    }),
  };
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = "openai-codex";
  settings.codex = {
    ...settings.codex,
    model: "gpt-6-astra",
    delegateAll: true,
  };
  return { original, input, dependencies, settings, events, dataUrl };
}

describe("Codex SFX execution", () => {
  it("rejects a cancelled request before opening or cropping its source", async () => {
    const { input, settings, dependencies } = fixture();
    input.abortController.abort();
    const run = createCodexSoundEffectRunner(dependencies);
    await expect(run(input, settings)).rejects.toThrow();
    expect(dependencies.open).not.toHaveBeenCalled();
    expect(dependencies.crop).not.toHaveBeenCalled();
  });
  it.each(["image", "font"] as const)(
    "routes explicit %s SFX requests under a general provider without legacy inpainting",
    async (sfxRendering) => {
      const { input, settings, dependencies } = fixture();
      settings.modelProvider = "openai-api";
      settings.codex.delegateAll = false;
      input.request.codexTypesetting = {
        ...resolveCodexTypesettingOptions(undefined, "ko"),
        sfxRendering,
      };
      const inpaintCreatedBlocks = vi.fn();
      const configured = structuredClone(settings);
      const result = await runSoundEffectTranslationJob(input, {
        createPipelineDependencies: () => {
          const pipeline = createDefaultWholePagePipelineDependencies();
          return {
            ...pipeline,
            settings: {
              ...pipeline.settings,
              getAppSettings: async () => settings,
            },
          };
        },
        runCodex: (job, options) =>
          runCodexSoundEffectTranslation(job, options, dependencies),
        appendResolvedBlocks: dependencies.append,
        getRunPaths: dependencies.paths,
        openChapter: dependencies.open,
        resolveWorkContext: dependencies.context,
        inpaintCreatedBlocks,
      });
      expect(result.status).toBe("completed");
      expect(
        vi.mocked(dependencies.run).mock.calls[0][0].codexTypesetting
          ?.regionOutput,
      ).toBe(sfxRendering === "image" ? "image" : "text");
      expect(inpaintCreatedBlocks).not.toHaveBeenCalled();
      expect(settings).toEqual(configured);
    },
  );
  it("batches font comparison, appends only selected effects and commits each background with its blocks", async () => {
    const { original, input, dependencies, settings, events, dataUrl } =
      fixture();
    const result = await runCodexSoundEffectTranslation(
      input,
      settings,
      dependencies,
    );
    expect(dependencies.run).toHaveBeenCalledOnce();
    const options = vi.mocked(dependencies.run).mock.calls[0][0];
    expect(options.codexTypesetting).toMatchObject({
      sfxRendering: "image",
      regionOutput: "image",
      eraseOriginal: true,
    });
    expect(options.pages).toHaveLength(2);
    for (const crop of options.pages) {
      expect(options.regionContexts?.get(crop.id)).toMatchObject({
        sourcePage: original.pages[0],
        sourcePageIndex: 0,
        cropRect: { x: 100, y: 160, w: 200, h: 320 },
      });
    }
    expect(options.writeStoryMemory).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.translatedRegionCount).toBe(2);
    expect(result.remainingRegionCount).toBe(0);
    expect(result.chapter.pages[0].blocks[0]).toEqual(
      original.pages[0].blocks[0],
    );
    expect(
      result.chapter.pages[0].blocks
        .slice(1)
        .map((block) => block.generatedLettering?.dataUrl),
    ).toEqual([dataUrl, dataUrl]);
    expect(
      result.chapter.pages[0].soundEffectReview?.resolvedRegions,
    ).toHaveLength(2);
    expect(
      vi.mocked(dependencies.artwork).mock.calls[1][0].source
        .inpaintedImagePath,
    ).toBe("crop-0-background.png");
    expect(result.chapter.pages[0].inpaintedImagePath).toBe(
      "crop-1-background.png",
    );
    expect(
      events
        .filter((event) => event.codexProgress)
        .map((event) => event.codexProgress),
    ).toMatchObject([
      { total: 1, page: 1, completed: 0 },
      { total: 1, page: 1, completed: 1 },
    ]);
  });
  it("keeps completed effects when a later effect is cancelled and never reruns generation", async () => {
    const { input, settings, dependencies } = fixture();
    const append = dependencies.append;
    dependencies.append = vi.fn(
      async (...args: Parameters<Dependencies["append"]>) => {
        const result = await append(...args);
        input.abortController.abort();
        return result;
      },
    );
    await expect(
      runCodexSoundEffectTranslation(input, settings, dependencies),
    ).rejects.toThrow();
    expect(input.state.translatedRegionCount).toBe(1);
    expect(dependencies.run).toHaveBeenCalledOnce();
    expect(dependencies.append).toHaveBeenCalledOnce();
    expect(input.state.chapter?.pages[0].blocks).toHaveLength(2);
  });
  it("keeps a non-Japanese or unreadable candidate pending", async () => {
    const { input, settings, dependencies } = fixture();
    dependencies.run = vi.fn(async (options: PipelineOptions) => {
      for (const crop of options.pages)
        await options.onPageComplete?.({
          ...crop,
          analysisStatus: "completed",
          blocks: [],
        });
      return { pages: [], warnings: [] };
    });
    const result = await runCodexSoundEffectTranslation(
      input,
      settings,
      dependencies,
    );
    expect(result.status).toBe("partial");
    expect(result.remainingRegionCount).toBe(2);
    expect(dependencies.append).not.toHaveBeenCalled();
    expect(dependencies.artwork).not.toHaveBeenCalled();
    expect(result.warnings).toHaveLength(2);
  });
});
