import type {
  AutoInpaintingChapterSelection,
  InpaintingPostprocessOptions,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../../shared/inpaintingTypes";
import { inpaintingGateway } from "../api/inpaintingGateway";
import type { PageTimingSessionRef } from "../../../shared/pageProcessingTiming";
import {
  createRendererPageTimingSession,
  finishRendererPageTimingSession,
} from "../lib/pageTimingSession";

type InpaintingSelectionOutcome =
  | "completed"
  | "partial"
  | "cancelled"
  | "failed"
  | "no-op";

type StartInpainting = (
  request: StartInpaintingRequest,
) => Promise<StartInpaintingResult>;

const NEVER_CANCEL = (): boolean => false;

export type SequentialInpaintingResult = {
  status: InpaintingSelectionOutcome;
  pagesChanged: number;
  blocksErased: number;
  pagesIncomplete: number;
  blocksIncomplete: number;
  error?: string;
};

type ChapterInpaintingAttempt = {
  status: Exclude<InpaintingSelectionOutcome, "no-op">;
  pagesChanged: number;
  blocksErased: number;
  pagesIncomplete: number;
  blocksIncomplete: number;
  error?: string;
};

type InpaintingAggregate = Omit<
  SequentialInpaintingResult,
  "status" | "error"
> & {
  anyPartial: boolean;
};

/**
 * Runs one main-process inpainting job per chapter. Completed changes from an
 * earlier chapter are preserved. A partially completed chapter is persisted
 * and the flow continues; only a hard failure or cancellation stops it.
 */
// eslint-disable-next-line complexity -- per-chapter ownership, cancellation, and partial-result settlement are one state machine
export async function runInpaintingSelectionsSequentially({
  onResult,
  postprocess,
  selections,
  shouldCancel,
  startInpainting = inpaintingGateway.startInpainting,
  timingSession,
  timingStartedAtEpochMs,
  workId,
}: {
  onResult?: (
    result: StartInpaintingResult,
    selection: AutoInpaintingChapterSelection,
  ) => Promise<void> | void;
  postprocess?: InpaintingPostprocessOptions;
  selections: AutoInpaintingChapterSelection[];
  shouldCancel?: () => boolean;
  startInpainting?: StartInpainting;
  timingSession?: PageTimingSessionRef;
  timingStartedAtEpochMs?: number;
  workId: string;
}): Promise<SequentialInpaintingResult> {
  if (selections.length === 0) {
    return {
      status: "no-op",
      pagesChanged: 0,
      blocksErased: 0,
      pagesIncomplete: 0,
      blocksIncomplete: 0,
    };
  }
  const isCancellationRequested = shouldCancel ?? NEVER_CANCEL;
  const aggregate = createInpaintingAggregate();

  if (timingSession && selections.length !== 1) {
    throw new Error("A continued timing session requires one chapter.");
  }

  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    if (!selection) continue;
    if (isCancellationRequested()) {
      return createSequentialInpaintingResult("cancelled", aggregate);
    }
    const chapterTimingSession =
      timingSession ??
      createRendererPageTimingSession(
        index === 0 ? timingStartedAtEpochMs : undefined,
      );
    const attempt = await runChapterInpainting({
      onResult,
      postprocess,
      selection,
      startInpainting,
      timingSession: chapterTimingSession,
      workId,
    });
    if (!timingSession) {
      await finishRendererPageTimingSession(
        selection.chapterId,
        chapterTimingSession,
        attempt.status === "completed" ? "completed" : "interrupted",
      );
    }
    addChapterAttempt(aggregate, attempt);
    const terminalStatus = getTerminalInpaintingStatus(
      attempt,
      isCancellationRequested(),
    );
    if (terminalStatus) {
      return createSequentialInpaintingResult(
        terminalStatus,
        aggregate,
        attempt.error,
      );
    }
  }

  return createSequentialInpaintingResult(
    aggregate.anyPartial ? "partial" : "completed",
    aggregate,
  );
}

function createInpaintingAggregate(): InpaintingAggregate {
  return {
    pagesChanged: 0,
    blocksErased: 0,
    pagesIncomplete: 0,
    blocksIncomplete: 0,
    anyPartial: false,
  };
}

function addChapterAttempt(
  aggregate: InpaintingAggregate,
  attempt: ChapterInpaintingAttempt,
): void {
  aggregate.pagesChanged += attempt.pagesChanged;
  aggregate.blocksErased += attempt.blocksErased;
  aggregate.pagesIncomplete += attempt.pagesIncomplete;
  aggregate.blocksIncomplete += attempt.blocksIncomplete;
  aggregate.anyPartial ||= attempt.status === "partial";
}

function getTerminalInpaintingStatus(
  attempt: ChapterInpaintingAttempt,
  cancellationRequested: boolean,
): "cancelled" | "failed" | undefined {
  if (attempt.status === "cancelled" || cancellationRequested) {
    return "cancelled";
  }
  return attempt.status === "failed" ? "failed" : undefined;
}

function createSequentialInpaintingResult(
  status: SequentialInpaintingResult["status"],
  aggregate: InpaintingAggregate,
  error?: string,
): SequentialInpaintingResult {
  return {
    status,
    pagesChanged: aggregate.pagesChanged,
    blocksErased: aggregate.blocksErased,
    pagesIncomplete: aggregate.pagesIncomplete,
    blocksIncomplete: aggregate.blocksIncomplete,
    ...(status === "failed" && error ? { error } : {}),
  };
}

async function runChapterInpainting({
  onResult,
  postprocess,
  selection,
  startInpainting,
  timingSession,
  workId,
}: {
  onResult?: (
    result: StartInpaintingResult,
    selection: AutoInpaintingChapterSelection,
  ) => Promise<void> | void;
  postprocess?: InpaintingPostprocessOptions;
  selection: AutoInpaintingChapterSelection;
  startInpainting: StartInpainting;
  timingSession: PageTimingSessionRef;
  workId: string;
}): Promise<ChapterInpaintingAttempt> {
  try {
    const result = await startInpainting(
      createChapterInpaintingRequest(
        workId,
        selection,
        postprocess,
        timingSession,
      ),
    );
    await onResult?.(result, selection);
    return toChapterInpaintingAttempt(result, selection, postprocess);
  } catch (error) {
    console.error(error);
    return {
      status: "failed",
      pagesChanged: 0,
      blocksErased: 0,
      pagesIncomplete: 0,
      blocksIncomplete: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toChapterInpaintingAttempt(
  result: StartInpaintingResult,
  selection: AutoInpaintingChapterSelection,
  postprocess: InpaintingPostprocessOptions | undefined,
): ChapterInpaintingAttempt {
  const counts = {
    pagesChanged: Math.max(0, result.pagesChanged ?? 0),
    blocksErased: Math.max(0, result.blocksErased ?? 0),
    pagesIncomplete: Math.max(0, result.pagesIncomplete ?? 0),
    blocksIncomplete: Math.max(0, result.blocksIncomplete ?? 0),
  };
  if (result.status === "cancelled") {
    return { status: "cancelled", ...counts };
  }
  if (isSuccessfulChapterResult(result, selection, postprocess)) {
    return { status: "completed", ...counts };
  }
  if (isPartialChapterResult(result, selection)) {
    return { status: "partial", ...counts };
  }
  return {
    status: "failed",
    ...counts,
    ...(result.error?.trim() ? { error: result.error.trim() } : {}),
  };
}

function isPartialChapterResult(
  result: StartInpaintingResult,
  selection: AutoInpaintingChapterSelection,
): boolean {
  return (
    result.status === "partial" &&
    (result.pagesChanged ?? 0) > 0 &&
    (result.blocksErased ?? 0) > 0 &&
    Boolean(
      result.chapters?.some(
        (candidate) => candidate.id === selection.chapterId,
      ),
    )
  );
}

function createChapterInpaintingRequest(
  workId: string,
  selection: AutoInpaintingChapterSelection,
  postprocess: InpaintingPostprocessOptions | undefined,
  timingSession: PageTimingSessionRef,
): StartInpaintingRequest {
  return {
    mode: "selection-pattern",
    workId,
    selections: [selection],
    timingSession,
    ...(postprocess ? { postprocess } : {}),
  };
}

function isSuccessfulChapterResult(
  result: StartInpaintingResult,
  selection: AutoInpaintingChapterSelection,
  postprocess: InpaintingPostprocessOptions | undefined,
): boolean {
  if (result.status !== "completed") return false;
  const chapter = result.chapters?.find(
    (candidate) => candidate.id === selection.chapterId,
  );
  if (!chapter) return false;
  if ((result.pagesChanged ?? 0) > 0) return true;

  const selectedPageIds =
    selection.mode === "page-set" ? new Set(selection.pageIds) : null;
  const selectedPages = chapter.pages.filter(
    (page) => !selectedPageIds || selectedPageIds.has(page.id),
  );
  const expectedWorkflow = postprocess?.bubbleLayout?.enabled
    ? "bubble-layout"
    : "erase-original";
  return (
    selectedPages.length > 0 &&
    selectedPages.every(
      (page) =>
        page.translationCompletion?.workflow === expectedWorkflow &&
        page.translationCompletion.status === "completed",
    )
  );
}
