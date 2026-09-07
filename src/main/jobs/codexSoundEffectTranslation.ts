import type { AppSettings } from "../../shared/settingsTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { JobEvent } from "../../shared/jobTypes";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
import { resolveCodexTypesettingOptions } from "../../shared/codexTypesettingDefaults";
import type {
  appendResolvedSoundEffectBlocks,
  getRunPaths,
  openChapter,
  resolveWorkContextForChapter,
} from "../library";
import {
  createRegionCropPage,
  mapRegionBlocksToPageBlocks,
} from "../regionCrop";
import { runCodexTypesettingPipeline } from "../pipeline/codexTypesettingRuntime";
import { prepareRegionArtwork } from "./regionTranslationArtwork";
import {
  countChapterPendingSoundEffectRegions,
  resolveStoredSoundEffectTargets,
} from "./soundEffectTranslationTargets";
import { emitSoundEffectTerminal } from "./soundEffectTranslationEvents";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";

type Dependencies = {
  append: typeof appendResolvedSoundEffectBlocks;
  paths: typeof getRunPaths;
  open: typeof openChapter;
  context: typeof resolveWorkContextForChapter;
  crop: typeof createRegionCropPage;
  run: typeof runCodexTypesettingPipeline;
  artwork: typeof prepareRegionArtwork;
};
export function createCodexSoundEffectRunner(
  repositories: Pick<Dependencies, "append" | "paths" | "open" | "context">,
) {
  return (input: SoundEffectTranslationJobInput, settings: AppSettings) =>
    runCodexSoundEffectTranslation(input, settings, {
      ...repositories,
      crop: createRegionCropPage,
      run: runCodexTypesettingPipeline,
      artwork: prepareRegionArtwork,
    });
}
type TargetCrop = Awaited<ReturnType<typeof createRegionCropPage>> & {
  pageId: string;
  regionId: string;
  pageIndex: number;
};

/** Share font comparison across the selected crops and commit each completed effect atomically. */
export async function runCodexSoundEffectTranslation(
  input: SoundEffectTranslationJobInput,
  settings: AppSettings,
  dependencies: Dependencies,
) {
  const { request, state, abortController, id } = input;
  abortController.signal.throwIfAborted();
  const chapter = await dependencies.open(request.chapterId);
  state.chapter = chapter;
  const targets = resolveStoredSoundEffectTargets(chapter, request);
  const runPaths = await dependencies.paths(request.chapterId, id);
  const workContext = await dependencies.context(request.chapterId);
  const codex = {
    ...(request.codexTypesetting ??
      resolveCodexTypesettingOptions(
        settings.ui?.codexTypesettingPreferences,
        settings.translation?.targetLanguage ?? "ko",
      )),
    eraseOriginal: request.inpaintAfterTranslation === true,
  };
  const crops: TargetCrop[] = [];
  for (const [pageIndex, target] of targets.entries())
    for (const region of target.regions) {
      abortController.signal.throwIfAborted();
      crops.push({
        ...(await dependencies.crop(
          target.page,
          region.bbox,
          `${id}-${crops.length}`,
          runPaths.runDir,
          input.context.decodeImage,
          abortController.signal,
        )),
        pageId: target.page.id,
        regionId: region.id,
        pageIndex,
      });
    }
  const result = await dependencies.run({
    jobId: id,
    runPaths,
    signal: abortController.signal,
    pages: crops.map((crop) => crop.cropPage),
    codexTypesetting: {
      ...codex,
      regionOutput: codex.sfxRendering === "image" ? "image" : "text",
    },
    writeStoryMemory: false,
    regionContexts: cropSourceContexts(crops, chapter.pages),
    workContext: { ...workContext, chapterId: chapter.id, recentPageCount: 6 },
    canonicalPageIndexById: new Map(
      crops.map((crop) => [
        crop.cropPage.id,
        chapter.pages.findIndex((page) => page.id === crop.pageId),
      ]),
    ),
    emit: (event) => emitCropProgress(input, event, crops, targets.length),
    onPageComplete: async (page) => {
      const crop = crops.find((item) => item.cropPage.id === page.id);
      if (!crop) throw new Error("효과음 결과의 원본 영역을 찾지 못했습니다.");
      return commitCrop(
        input,
        crop,
        page,
        codex,
        runPaths.runDir,
        dependencies,
      );
    },
  });
  state.warnings.push(...result.warnings);
  state.chapter = await dependencies.open(chapter.id);
  return completeSoundEffectRun(input, crops.length, targets.length);
}

function cropSourceContexts(crops: TargetCrop[], pages: MangaPage[]) {
  return new Map(
    crops.map((crop) => {
      const sourcePageIndex = pages.findIndex(
        (page) => page.id === crop.pageId,
      );
      const sourcePage = pages[sourcePageIndex];
      if (!sourcePage)
        throw new Error("효과음의 원본 페이지를 찾지 못했습니다.");
      return [
        crop.cropPage.id,
        { sourcePage, sourcePageIndex, cropRect: crop.cropRect },
      ];
    }),
  );
}

function completeSoundEffectRun(
  input: SoundEffectTranslationJobInput,
  requested: number,
  pageTotal: number,
) {
  const { state, id } = input;
  if (!state.chapter) throw new Error("효과음 저장 결과가 없습니다.");
  const status =
    state.translatedRegionCount === requested
      ? ("completed" as const)
      : ("partial" as const);
  emitSoundEffectTerminal(
    id,
    input.emit,
    status,
    pageTotal,
    state.translatedRegionCount,
  );
  return {
    status,
    chapter: state.chapter,
    createdBlocksByPage: state.createdBlocksByPage,
    translatedRegionCount: state.translatedRegionCount,
    remainingRegionCount: countChapterPendingSoundEffectRegions(state.chapter),
    warnings: state.warnings,
  };
}

async function commitCrop(
  input: SoundEffectTranslationJobInput,
  crop: TargetCrop,
  analyzed: MangaPage,
  codex: ReturnType<typeof resolveCodexTypesettingOptions>,
  directory: string,
  dependencies: Dependencies,
) {
  const { request, state, abortController } = input;
  const source = state.chapter?.pages.find((page) => page.id === crop.pageId);
  if (!source) throw new Error("효과음 페이지를 찾지 못했습니다.");
  const blocks = mapRegionBlocksToPageBlocks(
    analyzed.blocks,
    source,
    crop.cropRect,
  );
  const [block, ...additionalBlocks] = blocks;
  if (
    !block ||
    !blocks.some((item) => item.sourceText.trim() && item.translatedText.trim())
  ) {
    state.warnings.push(
      `${source.name}: 일본어 효과음을 확인하지 못한 영역은 그대로 남겼습니다.`,
    );
    return false;
  }
  const background = await dependencies.artwork({
    source,
    crop: crop.cropPage,
    analyzed,
    rect: crop.cropRect,
    directory,
    decode: input.context.decodeImage,
    signal: abortController.signal,
    request: {
      chapterId: request.chapterId,
      pageId: source.id,
      bbox: { x: 0, y: 0, w: 1000, h: 1000 },
      eraseOriginal: codex.eraseOriginal,
      codexTypesetting: codex,
    },
  });
  abortController.signal.throwIfAborted();
  state.chapter = await dependencies.append(
    request.chapterId,
    source.id,
    createSoundEffectReviewPageRevision(source),
    [{ regionId: crop.regionId, block, additionalBlocks }],
    background
      ? { inpaintedImagePath: background, inpaintMaskPath: undefined }
      : undefined,
  );
  const created = state.createdBlocksByPage.find(
    (page) => page.pageId === source.id,
  );
  if (created) created.blockIds.push(...blocks.map((item) => item.id));
  else
    state.createdBlocksByPage.push({
      pageId: source.id,
      blockIds: blocks.map((item) => item.id),
    });
  state.translatedRegionCount++;
  return true;
}

function emitCropProgress(
  input: SoundEffectTranslationJobInput,
  event: JobEvent,
  crops: TargetCrop[],
  total: number,
) {
  const progress = event.codexProgress;
  if (!progress)
    return input.emit({ ...event, kind: "sound-effect-translation" });
  const current = crops[Math.max(0, (progress.page ?? 1) - 1)];
  const completed =
    progress.completed >= crops.length
      ? total
      : (crops[progress.completed]?.pageIndex ?? 0);
  input.emit({
    ...event,
    kind: "sound-effect-translation",
    pageTotal: total,
    progressCurrent: completed,
    progressTotal: total,
    codexProgress: {
      ...progress,
      total,
      completed,
      ...(progress.page && current ? { page: current.pageIndex + 1 } : {}),
    },
  });
}
