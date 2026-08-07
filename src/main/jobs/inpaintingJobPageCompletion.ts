import type { MangaPage } from "../../shared/libraryTypes";
import { isBubbleLayoutBlockEligible } from "../bubbleLayout/bubbleLayoutBlockEligibility";
import { normalizeTranslationCompletionReferences } from "../translationCompletionReferences";
import { translationCompletionsEqual } from "../inpainting/inpaintingRevisionHelpers";
import {
  countEligiblePatternBlocks,
  hasInvalidRequiredPatternBlock,
  isPatternInpaintingBlockEligible,
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
  skipRequiredTargetValidation = false,
): void {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (
    target.blockId === undefined &&
    !target.drawnPatternMode &&
    !target.layoutOnly &&
    !skipRequiredTargetValidation &&
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
  state: InpaintingJobState,
  target: InpaintingTarget,
): number {
  if (target.drawnPatternMode) return target.drawnStrokes.length;
  if (target.layoutOnly) {
    return page.blocks.filter((block) =>
      isBubbleLayoutBlockEligible(block, target.blockId),
    ).length;
  }
  return countEligiblePatternBlocks(
    page,
    target.blockId,
    resolvePreviouslyErasedBlockIds(page, state, target),
  );
}

export function completeTargetlessInpaintingPage(
  page: MangaPage,
  state: InpaintingJobState,
  target: InpaintingTarget,
): ProcessedInpaintingPageResult {
  if (!canCompleteTranslationWorkflowWithoutTargets(page, state, target)) {
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
    workflowReceiptChanged: !translationCompletionsEqual(
      completed.page.translationCompletion,
      page.translationCompletion,
    ),
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
  state: InpaintingJobState,
  target: InpaintingTarget,
): boolean {
  if (target.blockId !== undefined || target.drawnPatternMode) {
    return false;
  }
  if (
    page.inpaintedImagePath &&
    page.translationCompletion?.status === "completed" &&
    pageHasMatchingTranslationCompletion(page, state, target)
  ) {
    return true;
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
  const completion = resolveNextTranslationCompletion(result, state, target);
  if (!completion) return result;
  return {
    ...result,
    page: {
      ...result.page,
      translationCompletion: completion,
    },
    workflowReceiptChanged: !translationCompletionsEqual(
      result.page.translationCompletion,
      completion,
    ),
  };
}

export function resolvePreviouslyErasedBlockIds(
  page: MangaPage,
  state: InpaintingJobState,
  target: InpaintingTarget,
): readonly string[] | undefined {
  if (
    target.blockId !== undefined ||
    target.drawnPatternMode ||
    target.layoutOnly
  ) {
    return undefined;
  }
  const completion = normalizeTranslationCompletionReferences(
    page.translationCompletion,
    page.blocks,
  );
  if (
    !completion ||
    completion.workflow !==
      resolveExpectedTranslationCompletionWorkflow(state, target)
  ) {
    return undefined;
  }
  if (
    page.inpaintedImagePath &&
    completion.status === "pending" &&
    completion.erasedBlockIds?.length
  ) {
    return completion.erasedBlockIds;
  }
  if (completion.status !== "completed" || !page.inpaintedImagePath) {
    return undefined;
  }
  return page.blocks
    .filter((block) => isPatternInpaintingBlockEligible(block))
    .map((block) => block.id);
}

function resolveNextTranslationCompletion(
  result: ProcessedInpaintingPageResult,
  state: InpaintingJobState,
  target: InpaintingTarget,
): MangaPage["translationCompletion"] {
  if (!ownsFullPageTranslationCompletion(target)) return undefined;
  const current = normalizeTranslationCompletionReferences(
    result.page.translationCompletion,
    result.page.blocks,
  );
  const expectedWorkflow = resolveExpectedTranslationCompletionWorkflow(
    state,
    target,
  );
  const isPartial = hasIncompleteInpaintingTargets(result);
  if (!current && !isPartial) return undefined;
  if (current && current.workflow !== expectedWorkflow) return undefined;
  const erasedBlockIds = mergeBlockIds(
    current?.erasedBlockIds,
    result.erasedBlockIds,
  );
  return {
    workflow: expectedWorkflow,
    status: isPartial ? "pending" : "completed",
    ...(erasedBlockIds.length > 0 ? { erasedBlockIds } : {}),
  };
}

function ownsFullPageTranslationCompletion(target: InpaintingTarget): boolean {
  return (
    target.blockId === undefined &&
    !target.drawnPatternMode &&
    !target.layoutOnly
  );
}

function hasIncompleteInpaintingTargets(
  result: ProcessedInpaintingPageResult,
): boolean {
  return countIncompleteInpaintingTargets(result) > 0;
}

export function countIncompleteInpaintingTargets(
  result: Pick<
    ProcessedInpaintingPageResult,
    "blocksIncomplete" | "incompleteBlockIds"
  >,
): number {
  return Math.max(
    result.blocksIncomplete ?? 0,
    result.incompleteBlockIds?.length ?? 0,
  );
}

function mergeBlockIds(
  previous: readonly string[] | undefined,
  current: readonly string[] | undefined,
): string[] {
  return [...new Set([...(previous ?? []), ...(current ?? [])])];
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
