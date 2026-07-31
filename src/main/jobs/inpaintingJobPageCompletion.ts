import type { MangaPage } from "../../shared/libraryTypes";
import { isBubbleLayoutBlockEligible } from "../bubbleLayout/bubbleLayoutBlockEligibility";
import {
  countEligiblePatternBlocks,
  hasInvalidRequiredPatternBlock,
} from "../inpainting/patternBlockEligibility";
import type {
  InpaintingJobState,
  InpaintingTarget,
  ProcessedInpaintingPageResult,
} from "./inpaintingJobPageTypes";
import { tMain } from "./localization";

export function assertInpaintingPageCanRun(
  signal: AbortSignal,
  page: MangaPage,
  target: InpaintingTarget,
): void {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (
    target.blockId === undefined &&
    !target.drawnPatternMode &&
    !target.layoutOnly &&
    hasInvalidRequiredPatternBlock(page)
  ) {
    throw new Error(tMain("inpainting.noTargets"));
  }
}

export function assertRequiredBubblePostprocess(
  sourcePage: MangaPage,
  result: ProcessedInpaintingPageResult,
  state: InpaintingJobState,
  target: InpaintingTarget,
): void {
  if (!requiresBubbleLayoutPostprocess(sourcePage, state, target)) {
    return;
  }
  if (!result.bubbleLayoutPostprocessed) {
    throw new Error(tMain("inpainting.noChanges"));
  }
}

function requiresBubbleLayoutPostprocess(
  sourcePage: MangaPage,
  state: InpaintingJobState,
  target: InpaintingTarget,
): boolean {
  if (target.layoutOnly || state.bubbleLayoutPostprocess) return true;
  const ownsFullPageCompletion =
    target.blockId === undefined &&
    !target.drawnPatternMode &&
    !target.layoutOnly;
  return (
    ownsFullPageCompletion &&
    sourcePage.translationCompletion?.workflow === "bubble-layout"
  );
}

export function countInpaintingPageTargets(
  page: MangaPage,
  target: InpaintingTarget,
): number {
  if (target.drawnPatternMode) return target.drawnStrokes.length;
  if (target.layoutOnly) {
    return page.blocks.filter((block) =>
      isBubbleLayoutBlockEligible(block, target.blockId),
    ).length;
  }
  return countEligiblePatternBlocks(page, target.blockId);
}

export function completeTargetlessInpaintingPage(
  page: MangaPage,
  state: InpaintingJobState,
  target: InpaintingTarget,
): ProcessedInpaintingPageResult {
  if (!canCompleteTranslationWorkflowWithoutTargets(page, target)) {
    throw new Error(tMain("inpainting.noTargets"));
  }
  if (!pageHasMatchingTranslationCompletion(page, state, target)) {
    return { page, blocksErased: 0 };
  }
  const completed = completeTranslationWorkflow(
    { page, blocksErased: 0 },
    state,
    target,
  );
  return {
    ...completed,
    workflowReceiptChanged:
      completed.page.translationCompletion?.status !==
      page.translationCompletion?.status,
  };
}

export function pageHasMatchingTranslationCompletion(
  page: MangaPage,
  state: InpaintingJobState,
  target: InpaintingTarget,
): boolean {
  return (
    page.translationCompletion?.workflow ===
    resolveExpectedTranslationCompletionWorkflow(state, target)
  );
}

export function canCompleteTranslationWorkflowWithoutTargets(
  page: MangaPage,
  target: InpaintingTarget,
): boolean {
  if (target.blockId !== undefined || target.drawnPatternMode) {
    return false;
  }
  return (
    page.blocks.length === 0 ||
    page.blocks.every((block) => block.inpaintExcluded === true)
  );
}

export function completeTranslationWorkflow(
  result: ProcessedInpaintingPageResult,
  state: InpaintingJobState,
  target: InpaintingTarget,
): ProcessedInpaintingPageResult {
  if (
    target.blockId !== undefined ||
    target.drawnPatternMode ||
    target.layoutOnly
  ) {
    return result;
  }
  const completion = result.page.translationCompletion;
  const expectedWorkflow = resolveExpectedTranslationCompletionWorkflow(
    state,
    target,
  );
  if (!completion || completion.workflow !== expectedWorkflow) return result;
  return {
    ...result,
    page: {
      ...result.page,
      translationCompletion: {
        ...completion,
        status: "completed",
      },
    },
  };
}

export function resolveExpectedTranslationCompletionWorkflow(
  state: InpaintingJobState,
  target?: Pick<InpaintingTarget, "layoutOnly">,
): "bubble-layout" | "erase-original" {
  return target?.layoutOnly ||
    state.requestedCompletionWorkflow === "bubble-layout" ||
    state.bubbleLayoutPostprocess
    ? "bubble-layout"
    : "erase-original";
}
