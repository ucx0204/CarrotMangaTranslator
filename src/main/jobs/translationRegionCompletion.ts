import { prepareRegionArtwork } from "./regionTranslationArtwork";
import { createPageRevision } from "../../shared/pageRevision";
import { recordRegionTranslationHistory } from "./translationRegionHistory";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
} from "../../shared/analysisTypes";
import type { JobEvent, JobFailureGuidance } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { mapRegionBlocksToPageBlocks } from "../regionCrop";
import { appendAnalyzedPageBlocks } from "../library";
import { runWholePagePipeline } from "../wholePagePipeline";
import { throwIfAborted } from "../pipeline/failure";
import type { TranslationJobContext } from "./translationJobTypes";
import { tMain } from "./localization";
type EmitJobEvent = (event: JobEvent) => void;
type PipelineResult = Awaited<ReturnType<typeof runWholePagePipeline>>;
export async function completeRegionTranslation({
  cropPage,
  context,
  directory,
  cropRect,
  emit,
  id,
  page,
  request,
  result,
  signal,
  appendBlocks,
}: {
  cropRect: Parameters<typeof mapRegionBlocksToPageBlocks>[2];
  emit: EmitJobEvent;
  id: string;
  page: MangaPage;
  request: RegionAnalysisRequest;
  result: PipelineResult;
  signal: AbortSignal;
  cropPage: MangaPage;
  context: TranslationJobContext;
  directory: string;
  appendBlocks: typeof appendAnalyzedPageBlocks;
}): Promise<RegionAnalysisResult> {
  const analyzedCrop = result.pages[0];
  assertCompletedRegionPipelineResult(analyzedCrop, result.failureGuidance);
  const translatedBlocks = analyzedCrop
    ? mapRegionBlocksToPageBlocks(analyzedCrop.blocks, page, cropRect)
    : [];
  const mappedBlocks = translatedBlocks;
  const background = await prepareRegionArtwork({
    source: page,
    crop: cropPage,
    analyzed: analyzedCrop,
    rect: cropRect,
    request,
    directory,
    decode: context.decodeImage,
    signal,
  });
  // Commit blocks and background together, rejecting a changed source revision.
  // Commit이 시작되기 전 취소만 이기며, 성공한 commit 뒤에는 cancelled로 뒤집지 않는다.
  throwIfAborted(signal);
  const saved = await appendBlocks(
    request.chapterId,
    request.pageId,
    mappedBlocks,
    ...(request.pageRevision || background
      ? [
          {
            expectedRevision: request.pageRevision ?? createPageRevision(page),
            ...(background
              ? {
                  image: {
                    inpaintedImagePath: background,
                    inpaintMaskPath: undefined,
                  },
                }
              : {}),
          },
        ]
      : []),
  );
  emitRegionCompleted(id, emit, mappedBlocks.length);
  return {
    status: "completed",
    history: recordRegionTranslationHistory(
      context.inpaintingRevisionStore,
      request.chapterId,
      page,
      saved.pages.find((item) => item.id === page.id) ?? page,
    ),
    chapter: saved,
    warnings: result.warnings,
    pageId: request.pageId,
    blockIds: mappedBlocks.map((block) => block.id),
  };
}

function assertCompletedRegionPipelineResult(
  page: MangaPage | undefined,
  failureGuidance?: JobFailureGuidance,
): asserts page is MangaPage {
  if (page?.analysisStatus === "completed") {
    return;
  }
  const error = new Error(page?.lastError?.trim() || tMain("region.failed"));
  if (failureGuidance) {
    Object.assign(error, { failureGuidance });
  }
  throw error;
}

function emitRegionCompleted(
  id: string,
  emit: EmitJobEvent,
  blockCount: number,
): void {
  emit({
    id,
    kind: "gemma-analysis",
    status: "completed",
    progressText: tMain("region.completed"),
    phase: "done",
    progressCurrent: 1,
    progressTotal: 1,
    pageTotal: 1,
    detail: tMain("units.blocks", { count: blockCount }),
  });
}
