import type { TranslationCompletionReceipt } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";

export function resolveCompletionAfterBlockMutation(
  current: TranslationCompletionReceipt | undefined,
  previousBlocks: readonly TranslationBlock[],
  nextBlocks: readonly TranslationBlock[],
): TranslationCompletionReceipt | undefined {
  if (!current) return undefined;
  if (
    targetBlockState(previousBlocks, current.workflow) ===
    targetBlockState(nextBlocks, current.workflow)
  ) {
    return current;
  }
  return { workflow: current.workflow, status: "pending" };
}

function targetBlockState(
  blocks: readonly TranslationBlock[],
  workflow: TranslationCompletionReceipt["workflow"],
): string {
  return JSON.stringify(
    [...blocks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((block) => ({
        id: block.id,
        bbox: block.bbox,
        bboxSpace: block.bboxSpace ?? "normalized_1000",
        inpaintExcluded: block.inpaintExcluded === true,
        ...(workflow === "bubble-layout"
          ? {
              curveLayout: block.curveLayout ?? null,
              renderDirection: block.renderDirection,
              translatedText: block.translatedText,
            }
          : {}),
      })),
  );
}
