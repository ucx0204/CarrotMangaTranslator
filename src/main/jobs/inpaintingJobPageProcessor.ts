import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { InpaintingMaskStroke } from "../../shared/inpaintingTypes";
import {
  runBubbleLayoutPostprocess,
  type BubbleLayoutPostprocessConfig,
  type BubbleLayoutRunner,
} from "../inpainting/bubbleLayoutRunner";
import type { InpaintingBlockLayoutState } from "../inpainting/inpaintingLayoutState";
import { runBubbleLayoutOnlyPage } from "./bubbleLayoutJob";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";
import {
  emitInpaintingPageDone,
  emitInpaintingPageRunning,
} from "./inpaintingJobProgress";

type InpaintingPageResult = Awaited<
  ReturnType<InpaintingJobRuntime["inpaintPatternPage"]>
>;
type OpenedChapter = Awaited<ReturnType<InpaintingJobRuntime["openChapter"]>>;
type InpaintingEngineLease = Awaited<
  ReturnType<InpaintingJobRuntime["acquireEngine"]>
>;

export type InpaintingJobState = {
  chapter: OpenedChapter | null;
  chapters: Map<string, OpenedChapter>;
  historyTransactionId: string | null;
  inpaintingEngineLease: InpaintingEngineLease | null;
  bubbleLayoutRunner: BubbleLayoutRunner | null;
  bubbleLayoutPostprocess: BubbleLayoutPostprocessConfig | null;
};

export type InpaintingTarget = {
  blockId?: string;
  drawnPatternMode: boolean;
  layoutOnly: boolean;
  drawnStrokes: InpaintingMaskStroke[];
  drawnFeatherPx?: number;
  targetType: "drawn" | "source";
};

export type ProcessedInpaintingPageResult = InpaintingPageResult & {
  beforeLayout?: InpaintingBlockLayoutState[];
  afterLayout?: InpaintingBlockLayoutState[];
};

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
  if (abortController.signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const pageTargetCount = target.blockId
    ? 1
    : target.drawnPatternMode
      ? target.drawnStrokes.length
      : page.blocks.length;
  emitInpaintingPageRunning(id, emit, page, pageIndex, pageCount, {
    pageTargetCount,
    target,
  });
  if (target.layoutOnly) {
    return processLayoutOnlyInpaintingPage({
      emit,
      id,
      page,
      pageCount,
      pageIndex,
      state,
      target,
      signal: abortController.signal,
    });
  }
  const result = target.drawnPatternMode
    ? await runtime.inpaintDrawnPage(page, {
        signal: abortController.signal,
        decodeFallback: context.decodeImage,
        inpaintingEngine: state.inpaintingEngineLease?.engine,
        strokes: target.drawnStrokes,
        featherPx: target.drawnFeatherPx,
      })
    : await runtime.inpaintPatternPage(page, {
        blockId: target.blockId,
        signal: abortController.signal,
        decodeFallback: context.decodeImage,
        inpaintingEngine: state.inpaintingEngineLease?.engine,
      });
  const processed =
    result.blocksErased > 0 &&
    state.bubbleLayoutPostprocess &&
    state.bubbleLayoutRunner
      ? await runBubbleLayoutPostprocess({
          config: state.bubbleLayoutPostprocess,
          blockId: target.blockId,
          page: result.page,
          runner: state.bubbleLayoutRunner,
          signal: abortController.signal,
        })
      : { page: result.page };
  emitInpaintingPageDone(
    id,
    emit,
    pageIndex,
    pageCount,
    target,
    result.blocksErased,
  );
  return {
    ...result,
    ...processed,
  };
}

async function processLayoutOnlyInpaintingPage({
  emit,
  id,
  page,
  pageCount,
  pageIndex,
  signal,
  state,
  target,
}: {
  emit: (event: JobEvent) => void;
  id: string;
  page: MangaPage;
  pageCount: number;
  pageIndex: number;
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
  emitInpaintingPageDone(
    id,
    emit,
    pageIndex,
    pageCount,
    target,
    result.blocksErased,
  );
  return result;
}
