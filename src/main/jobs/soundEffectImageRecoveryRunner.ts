import type { MangaPage } from "../../shared/libraryTypes";
import {
  createPageRevision,
  createPageJobTargetSnapshot,
} from "../../shared/pageRevision";
import { pageContentResource } from "../../shared/appActivityTypes";
import {
  openChapter,
  getRunPaths,
  updatePagesAfterInpainting,
} from "../library";
import {
  CodexImageEditError,
  CodexImageRedactionOverlapError,
  editTranslatedPageWithCodex,
} from "../codexImageEditing";
import { ImageCheckpointError } from "../pipeline/imageJobFailure";
import { createCodexProgressReporter } from "../pipeline/codexTypesettingProgress";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";
import {
  acquireJobPage,
  releaseJobPage,
  reserveJobChapter,
} from "./jobPageOwnership";
import {
  saveSoundEffectImageRecovery,
  loadSoundEffectImageRecovery,
  type SoundEffectImageRecoveryPlan,
} from "../soundEffectImageRecoveryStore";
import { withImageRedactionReview } from "./imageRedactionReview";

export type SoundEffectImageRecoveryDependencies = {
  editImages: typeof editTranslatedPageWithCodex;
  openChapter: typeof openChapter;
  saveImages: typeof updatePagesAfterInpainting;
  getRunPaths: typeof getRunPaths;
  saveRecovery: typeof saveSoundEffectImageRecovery;
};
const productionDependencies: SoundEffectImageRecoveryDependencies = {
  editImages: editTranslatedPageWithCodex,
  openChapter,
  saveImages: updatePagesAfterInpainting,
  getRunPaths,
  saveRecovery: saveSoundEffectImageRecovery,
};

export async function resumeSoundEffectImages(
  input: SoundEffectTranslationJobInput,
) {
  const chapter = await openChapter(input.request.chapterId);
  const plan = await loadSoundEffectImageRecovery(
    chapter,
    input.request.resumeImageRunId ?? "",
  );
  if (!plan)
    throw new Error("이어서 실행할 효과음 이미지 작업을 찾지 못했습니다.");
  const pages = plan.pages.filter((page) => !page.completed);
  const requested = new Set(input.request.targets.map((page) => page.pageId));
  if (pages.some((page) => !requested.has(page.pageId)))
    throw new Error("복구할 효과음 페이지 목록이 변경되었습니다.");
  input.state.chapter = chapter;
  reserveJobChapter(
    input.context.jobs,
    input.id,
    chapter,
    pages.map((page) => page.pageId),
  );
  return withImageRedactionReview(
    {
      jobId: input.id,
      kind: "sound-effect-translation",
      pages: chapter.pages.filter((page) => requested.has(page.id)),
      signal: input.abortController.signal,
      emit: input.emit,
      imageEdit: true,
    },
    async () => {
      const errors = await runSoundEffectImageRecovery(input, plan);
      const remaining = plan.pages.filter((page) => !page.completed).length;
      const status = remaining ? ("partial" as const) : ("completed" as const);
      const detail = remaining
        ? `번역문과 지정 영역은 보존했습니다. 이미지 작업 ${remaining}페이지를 다시 시도할 수 있습니다.`
        : "저장된 효과음 이미지 작업을 완료했습니다.";
      input.emit({
        id: input.id,
        kind: "sound-effect-translation",
        status,
        phase: remaining ? "partial" : "done",
        progressText: "효과음 이미지 작업",
        detail,
      });
      return {
        status,
        chapter: input.state.chapter ?? chapter,
        createdBlocksByPage: pages.map((page) => ({
          pageId: page.pageId,
          blockIds: page.blockIds,
        })),
        translatedRegionCount: 0,
        remainingRegionCount: 0,
        warnings: errors.slice(0, 500),
        ...(remaining ? { error: detail } : {}),
      };
    },
  );
}

/** Text is already durable. Each completed image/region checkpoints independently. */
export async function runSoundEffectImageRecovery(
  input: SoundEffectTranslationJobInput,
  plan: SoundEffectImageRecoveryPlan,
  dependencies = productionDependencies,
): Promise<string[]> {
  const errors: string[] = [];
  const pages = plan.pages.filter((page) => !page.completed);
  const paths = await dependencies.getRunPaths(plan.chapterId, plan.runId);
  const report = createCodexProgressReporter(
    input.id,
    pages.length,
    input.emit,
    "sound-effect-translation",
  );
  await dependencies.saveRecovery(plan);
  for (const [index, target] of pages.entries()) {
    input.abortController.signal.throwIfAborted();
    const error = await recoverPageImage(
      input,
      plan,
      target,
      dependencies,
      paths.runDir,
      (update) =>
        report({
          ...update,
          stage: "images",
          page: index + 1,
          completed: index,
        }),
    );
    if (error) errors.push(error);
    await dependencies.saveRecovery(plan);
    releaseJobPage(
      input.context.jobs,
      input.id,
      plan.chapterId,
      target.pageId,
      !target.completed,
    );
    input.emit({
      id: input.id,
      kind: "sound-effect-translation",
      status: "running",
      phase: "page_done",
      progressText: target.completed
        ? "효과음 이미지 저장 완료"
        : "이 페이지 이미지 작업 보류 · 다음 페이지 진행",
      pageIndex: index + 1,
      pageTotal: pages.length,
      progressCurrent: index + 1,
      progressTotal: pages.length,
      codexProgress: {
        stage: "images",
        step: "saving",
        page: index + 1,
        completed: index + 1,
        total: pages.length,
      },
      detail: error,
    });
  }
  return errors;
}

function createImageCheckpoint(
  input: SoundEffectTranslationJobInput,
  plan: SoundEffectImageRecoveryPlan,
  target: SoundEffectImageRecoveryPlan["pages"][number],
  saved: { page: MangaPage },
  dependencies: SoundEffectImageRecoveryDependencies,
) {
  return async (page: MangaPage, erasedBlockId?: string) => {
    input.abortController.signal.throwIfAborted();
    const current = saved.page;
    const updates = new Map(page.blocks.map((block) => [block.id, block]));
    const next = {
      ...current,
      inpaintedImagePath: page.inpaintedImagePath,
      inpaintMaskPath: page.inpaintMaskPath,
      blocks: current.blocks.map((block) => updates.get(block.id) ?? block),
    };
    const chapter = await dependencies.saveImages(plan.chapterId, [next], {
      expectedTargets: [createPageJobTargetSnapshot(plan.chapterId, current)],
      layoutPatches: [
        {
          pageId: next.id,
          states: [],
          replacementBlocks: next.blocks,
          expectedRevision: createPageRevision(current),
        },
      ],
    });
    const stored = chapter.pages.find((page) => page.id === target.pageId);
    if (!stored) throw new Error("효과음 저장 결과에 페이지가 없습니다.");
    saved.page = stored;
    input.state.chapter = chapter;
    target.revision = createPageRevision(stored);
    target.reading = {
      ...target.reading,
      regions: target.reading.regions.map((region) => {
        const block = stored.blocks.find((block) => block.id === region.id);
        return block
          ? {
              ...region,
              sourceBbox: block.bbox,
              renderBbox: block.renderBbox ?? block.bbox,
            }
          : region;
      }),
    };
    if (erasedBlockId && !target.erasedBlockIds.includes(erasedBlockId))
      target.erasedBlockIds.push(erasedBlockId);
    await dependencies.saveRecovery(plan);
  };
}

async function recoverPageImage(
  input: SoundEffectTranslationJobInput,
  plan: SoundEffectImageRecoveryPlan,
  target: SoundEffectImageRecoveryPlan["pages"][number],
  dependencies: SoundEffectImageRecoveryDependencies,
  directory: string,
  progress: Parameters<typeof editTranslatedPageWithCodex>[0]["progress"],
): Promise<string | undefined> {
  const resource = pageContentResource(plan.chapterId, target.pageId);
  const held = input.context.jobs
    .get(input.id)
    ?.resources?.some(
      (item) => item.kind === resource.kind && item.scope === resource.scope,
    );
  const chapter = await dependencies.openChapter(plan.chapterId);
  const current =
    held || !input.context.jobs.get(input.id)?.resources
      ? chapter.pages.find((page) => page.id === target.pageId)
      : await acquireJobPage(
          input.context.jobs,
          input.id,
          plan.chapterId,
          target.pageId,
          dependencies.openChapter,
        );
  if (!current || createPageRevision(current) !== target.revision)
    throw new Error(
      "저장된 효과음 페이지가 편집되었습니다. 이전 이미지 결과로 덮어쓰지 않았습니다.",
    );
  const saved = { page: current };
  const checkpoint = createImageCheckpoint(
    input,
    plan,
    target,
    saved,
    dependencies,
  );
  try {
    const edited = await dependencies.editImages({
      page: {
        ...current,
        blocks: current.blocks.filter((block) =>
          target.blockIds.includes(block.id),
        ),
      },
      directory,
      signal: input.abortController.signal,
      eraseOriginal: plan.eraseOriginal,
      output: plan.output,
      reviewedReading: target.reading,
      erasedBlockIds: target.erasedBlockIds,
      decode: input.context.decodeImage,
      onCheckpoint: checkpoint,
      progress,
    });
    input.abortController.signal.throwIfAborted();
    await checkpoint(edited);
    target.completed = true;
    target.error = undefined;
  } catch (error) {
    input.abortController.signal.throwIfAborted();
    if (error instanceof CodexImageRedactionOverlapError) {
      target.error = error.message;
      return `${current.name}: 번역문 저장됨 · 이미지 보류. ${target.error}`;
    }
    if (!(error instanceof CodexImageEditError)) throw error;
    try {
      await checkpoint(error.page);
    } catch (saveError) {
      throw new ImageCheckpointError(saveError);
    }
    target.error = error.message.slice(0, 4000);
    return `${current.name}: ${target.error}`;
  }
  return undefined;
}
