import type {
  AutoInpaintingChapterSelection,
  InpaintingPostprocessOptions,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../../shared/inpaintingTypes";
import { inpaintingGateway } from "../api/inpaintingGateway";

type InpaintingSelectionOutcome =
  | "completed"
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
  error?: string;
};

type ChapterInpaintingAttempt = {
  status: Exclude<InpaintingSelectionOutcome, "no-op">;
  pagesChanged: number;
  blocksErased: number;
  error?: string;
};

/**
 * Runs one main-process inpainting job per chapter. Completed changes from an
 * earlier chapter are preserved, but a failed or cancelled chapter stops the
 * remaining selections so a later chapter can never overtake incomplete work.
 */
export async function runInpaintingSelectionsSequentially({
  onResult,
  postprocess,
  selections,
  shouldCancel,
  startInpainting = inpaintingGateway.startInpainting,
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
  workId: string;
}): Promise<SequentialInpaintingResult> {
  if (selections.length === 0) {
    return { status: "no-op", pagesChanged: 0, blocksErased: 0 };
  }
  const isCancellationRequested = shouldCancel ?? NEVER_CANCEL;

  let pagesChanged = 0;
  let blocksErased = 0;

  for (const selection of selections) {
    if (isCancellationRequested()) {
      return { status: "cancelled", pagesChanged, blocksErased };
    }
    const attempt = await runChapterInpainting({
      onResult,
      postprocess,
      selection,
      startInpainting,
      workId,
    });
    pagesChanged += attempt.pagesChanged;
    blocksErased += attempt.blocksErased;
    if (attempt.status === "cancelled" || isCancellationRequested()) {
      return { status: "cancelled", pagesChanged, blocksErased };
    }
    if (attempt.status === "failed") {
      return {
        status: "failed",
        pagesChanged,
        blocksErased,
        ...(attempt.error ? { error: attempt.error } : {}),
      };
    }
  }

  return {
    status: "completed",
    pagesChanged,
    blocksErased,
  };
}

async function runChapterInpainting({
  onResult,
  postprocess,
  selection,
  startInpainting,
  workId,
}: {
  onResult?: (
    result: StartInpaintingResult,
    selection: AutoInpaintingChapterSelection,
  ) => Promise<void> | void;
  postprocess?: InpaintingPostprocessOptions;
  selection: AutoInpaintingChapterSelection;
  startInpainting: StartInpainting;
  workId: string;
}): Promise<ChapterInpaintingAttempt> {
  try {
    const result = await startInpainting(
      createChapterInpaintingRequest(workId, selection, postprocess),
    );
    await onResult?.(result, selection);
    const counts = {
      pagesChanged: Math.max(0, result.pagesChanged ?? 0),
      blocksErased: Math.max(0, result.blocksErased ?? 0),
    };
    if (result.status === "cancelled") {
      return { status: "cancelled", ...counts };
    }
    if (isSuccessfulChapterResult(result, selection, postprocess)) {
      return { status: "completed", ...counts };
    }
    return {
      status: "failed",
      ...counts,
      ...(result.error?.trim() ? { error: result.error.trim() } : {}),
    };
  } catch (error) {
    console.error(error);
    return {
      status: "failed",
      pagesChanged: 0,
      blocksErased: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createChapterInpaintingRequest(
  workId: string,
  selection: AutoInpaintingChapterSelection,
  postprocess: InpaintingPostprocessOptions | undefined,
): StartInpaintingRequest {
  return {
    mode: "selection-pattern",
    workId,
    selections: [selection],
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
