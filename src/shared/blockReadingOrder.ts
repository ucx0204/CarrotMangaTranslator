import type { TranslationBlock } from "./textTypes";

export type BlockReadingDirection = "rtl" | "ltr";

type PositionedBlock = Pick<TranslationBlock, "bbox">;

/**
 * Orders page blocks in natural reading order. Blocks are grouped into visual
 * rows from top to bottom, then ordered horizontally inside each row. Japanese
 * manga defaults to right-to-left while callers may explicitly request LTR.
 */
export function sortBlocksForReading<T extends PositionedBlock>(
  blocks: readonly T[],
  direction: BlockReadingDirection = "rtl",
): T[] {
  const items = [...blocks];
  if (items.length <= 1) {
    return items;
  }

  items.sort((left, right) => left.bbox.y - right.bbox.y);
  const rows: T[][] = [];
  for (const block of items) {
    const row = rows[rows.length - 1];
    if (row && belongsToReadingRow(row[0], block)) {
      row.push(block);
    } else {
      rows.push([block]);
    }
  }

  for (const row of rows) {
    row.sort((left, right) =>
      direction === "rtl"
        ? right.bbox.x - left.bbox.x
        : left.bbox.x - right.bbox.x,
    );
  }
  return rows.flat();
}

function belongsToReadingRow(
  reference: PositionedBlock,
  candidate: PositionedBlock,
): boolean {
  const referenceCenter = reference.bbox.y + reference.bbox.h / 2;
  const candidateCenter = candidate.bbox.y + candidate.bbox.h / 2;
  const threshold = Math.max(reference.bbox.h, candidate.bbox.h) * 0.5;
  return Math.abs(candidateCenter - referenceCenter) <= threshold;
}
