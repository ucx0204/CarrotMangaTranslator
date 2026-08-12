import type { TranslationBlock } from "../../../shared/textTypes";
import {
  resolvePageBlocksForReading,
  type BlockReadingDirection,
} from "../../../shared/blockReadingOrder";

export type BlockNavigationDirection = "previous" | "next";

/** Resolves a neighboring block without wrapping across page boundaries. */
export function resolveAdjacentBlockId(
  blocks: readonly TranslationBlock[],
  selectedBlockId: string | null,
  direction: BlockNavigationDirection,
  readingDirection: BlockReadingDirection = "rtl",
  blockOrder?: readonly string[],
): string | null {
  const ordered = resolvePageBlocksForReading(
    { blocks, blockOrder },
    readingDirection,
  );
  if (ordered.length === 0) {
    return null;
  }

  const selectedIndex = ordered.findIndex(
    (block) => block.id === selectedBlockId,
  );
  if (selectedIndex < 0) {
    return direction === "next"
      ? (ordered[0]?.id ?? null)
      : (ordered[ordered.length - 1]?.id ?? null);
  }

  const targetIndex =
    direction === "previous" ? selectedIndex - 1 : selectedIndex + 1;
  return ordered[targetIndex]?.id ?? null;
}
