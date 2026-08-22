import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import { runBubbleLayoutPostprocess } from "../inpainting/bubbleLayoutRunner";
import {
  applyInpaintingLayoutStates,
  type InpaintingBlockLayoutState,
} from "../inpainting/inpaintingLayoutState";
import {
  resolveEligiblePatternBlocks,
  shouldUseOriginalPatternImage,
} from "../inpainting/patternBlockEligibility";
import {
  runBubbleLayoutMaskPrepass,
  runBubbleLayoutOnlyPage,
} from "./bubbleLayoutJob";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";
import type {
  InpaintingJobState,
  InpaintingTarget,
  ProcessedInpaintingPageResult,
} from "./inpaintingJobPageTypes";
import { tMain } from "./localization";
import {
  assertInpaintingPageCanRun,
  assertRequiredBubblePostprocess,
  canCompleteTranslationWorkflowWithoutTargets,
  completeTargetlessInpaintingPage,
  completeTranslationWorkflow,
  countInpaintingPageTargets,
  resolvePreviouslyErasedBlockIds,
} from "./inpaintingJobPageCompletion";
import {
  emitInpaintingPageDone,
  emitInpaintingPageRunning,
} from "./inpaintingJobProgress";

type ProcessInpaintingPageOptions = {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: (event: JobEvent) => void;
  id: string;
  page: MangaPage;
  pageIndex: number;
  pageCount: number;
  state: InpaintingJobState;
  target: InpaintingTarget;
  runtime: InpaintingJobRuntime;
};

type RunInpaintingPagePipelineOptions = Pick<
  ProcessInpaintingPageOptions,
  "context" | "page" | "runtime" | "state" | "target"
> & { signal: AbortSignal };

export async function processInpaintingPage({
  abortController,
  context,
  emit,
  id,
  page,
  pageIndex,
  pageCount,
  state,
  target,
  runtime,
}: ProcessInpaintingPageOptions): Promise<ProcessedInpaintingPageResult> {
  const pageTargetCount = countInpaintingPageTargets(page, state, target);
  assertInpaintingPageCanRun(
    abortController.signal,
    page,
    target,
    pageTargetCount === 0 &&
      canCompleteTranslationWorkflowWithoutTargets(page, state, target),
  );
  emitInpaintingPageRunning(id, emit, page, pageIndex, pageCount, {
    pageTargetCount,
    target,
  });
  if (pageTargetCount === 0) {
    const result = completeTargetlessInpaintingPage(page, state, target);
    emitInpaintingPageDone(id, emit, pageIndex, pageCount, target, 0);
    return result;
  }
  const result = target.layoutOnly
    ? await processLayoutOnlyInpaintingPage({
        page,
        state,
        target,
        signal: abortController.signal,
      })
    : await runInpaintingPagePipeline({
        context,
        page,
        runtime,
        signal: abortController.signal,
        state,
        target,
      });
  return finishProcessedInpaintingPage({
    emit,
    id,
    page,
    pageCount,
    pageIndex,
    result,
    state,
    target,
  });
}

function finishProcessedInpaintingPage({
  emit,
  id,
  page,
  pageCount,
  pageIndex,
  result,
  state,
  target,
}: {
  emit: (event: JobEvent) => void;
  id: string;
  page: MangaPage;
  pageCount: number;
  pageIndex: number;
  result: ProcessedInpaintingPageResult;
  state: InpaintingJobState;
  target: InpaintingTarget;
}): ProcessedInpaintingPageResult {
  if (result.blocksErased <= 0) {
    throw new Error(tMain("inpainting.noChanges"));
  }
  assertRequiredBubblePostprocess(page, result, state, target);
  emitInpaintingPageDone(
    id,
    emit,
    pageIndex,
    pageCount,
    target,
    result.blocksErased,
  );
  return completeTranslationWorkflow(result, state, target);
}

async function runInpaintingPagePipeline({
  context,
  page,
  runtime,
  signal,
  state,
  target,
}: RunInpaintingPagePipelineOptions): Promise<ProcessedInpaintingPageResult> {
  const maskPreparation = target.drawnPatternMode
    ? { page }
    : await preparePatternMaskPage({
        page,
        signal,
        state,
        target,
      });
  const rawResult = target.drawnPatternMode
    ? await runtime.inpaintDrawnPage(page, {
        signal,
        decodeFallback: context.decodeImage,
        inpaintingEngine: state.inpaintingEngineLease?.engine,
        strokes: target.drawnStrokes,
        featherPx: target.drawnFeatherPx,
      })
    : await runtime.inpaintPatternPage(maskPreparation.page, {
        blockId: target.blockId,
        excludedBlockIds: resolvePreviouslyErasedBlockIds(page, state, target),
        signal,
        decodeFallback: context.decodeImage,
        inpaintingEngine: state.inpaintingEngineLease?.engine,
        ...("bubbleLayoutConstraintBlockIds" in maskPreparation
          ? {
              bubbleLayoutConstraintBlockIds:
                maskPreparation.bubbleLayoutConstraintBlockIds,
            }
          : {}),
        ...("sharedInpaintGroupIdsByBlock" in maskPreparation
          ? {
              sharedInpaintGroupIdsByBlock:
                maskPreparation.sharedInpaintGroupIdsByBlock,
            }
          : {}),
        ...("typographySegmentation" in maskPreparation
          ? {
              typographySegmentation: maskPreparation.typographySegmentation,
            }
          : {}),
      });
  const result: ProcessedInpaintingPageResult = {
    ...rawResult,
    page: maskPreparation.restoreLayout
      ? applyInpaintingLayoutStates(
          rawResult.page,
          maskPreparation.restoreLayout,
        )
      : rawResult.page,
  };
  if (
    result.blocksErased <= 0 ||
    !state.bubbleLayoutPostprocess ||
    !state.bubbleLayoutRunner
  ) {
    return result;
  }
  const processed = await runBubbleLayoutPostprocess({
    config: state.bubbleLayoutPostprocess,
    blockId: target.blockId,
    ...resolveBubblePostprocessBlockSelection(target, result),
    page: result.page,
    runner: state.bubbleLayoutRunner,
    signal,
  });
  return {
    ...result,
    ...processed,
    bubbleLayoutPostprocessed: true,
  };
}

function resolveBubblePostprocessBlockSelection(
  target: InpaintingTarget,
  result: ProcessedInpaintingPageResult,
): { blockIds?: readonly string[] } {
  return target.blockId === undefined && result.erasedBlockIds
    ? { blockIds: result.erasedBlockIds }
    : {};
}

async function preparePatternMaskPage({
  page,
  signal,
  state,
  target,
}: {
  page: MangaPage;
  signal: AbortSignal;
  state: InpaintingJobState;
  target: InpaintingTarget;
}): Promise<{
  bubbleLayoutConstraintBlockIds?: string[];
  page: MangaPage;
  restoreLayout?: InpaintingBlockLayoutState[];
  sharedInpaintGroupIdsByBlock?: Record<string, string[]>;
  typographySegmentation?: KoharuTypographySegmentation;
}> {
  if (
    state.inpaintingEngineLease?.engine.model !== "flux-klein" ||
    !state.bubbleLayoutPostprocess ||
    !state.bubbleLayoutRunner
  ) {
    return { page };
  }
  const previouslyErasedBlockIds = resolvePreviouslyErasedBlockIds(
    page,
    state,
    target,
  );
  const retryBlockIds = previouslyErasedBlockIds?.length
    ? resolveEligiblePatternBlocks(
        page,
        target.blockId,
        previouslyErasedBlockIds,
      ).map((block) => block.id)
    : undefined;
  const prepassPage = shouldUseOriginalPatternImage(page)
    ? { ...page, inpaintedImagePath: undefined }
    : page;
  const prepared = await runBubbleLayoutMaskPrepass({
    blockId: target.blockId,
    ...(retryBlockIds ? { blockIds: retryBlockIds } : {}),
    config: state.bubbleLayoutPostprocess,
    page: prepassPage,
    runner: state.bubbleLayoutRunner,
    signal,
  });
  return { ...prepared };
}

async function processLayoutOnlyInpaintingPage({
  page,
  signal,
  state,
  target,
}: {
  page: MangaPage;
  signal: AbortSignal;
  state: InpaintingJobState;
  target: InpaintingTarget;
}): Promise<ProcessedInpaintingPageResult> {
  const result = await runBubbleLayoutOnlyPage({
    blockId: target.blockId,
    config: state.bubbleLayoutPostprocess,
    page,
    runner: state.bubbleLayoutRunner,
    signal,
  });
  return { ...result, bubbleLayoutPostprocessed: true };
}
