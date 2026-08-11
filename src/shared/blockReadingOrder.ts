import type { TranslationBlock } from "./textTypes";

export type BlockReadingDirection = "rtl" | "ltr";
export type StoredReadingDirection = "auto" | BlockReadingDirection;

type PositionedBlock = Pick<TranslationBlock, "bbox">;
type IdentifiedPositionedBlock = PositionedBlock & Pick<TranslationBlock, "id">;

export type PageBlockOrderSource<T extends IdentifiedPositionedBlock> = {
  blocks: readonly T[];
  blockOrder?: readonly string[];
};

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

/**
 * Resolves an explicit page order while safely repairing legacy, duplicate, or
 * stale ids. New blocks are appended using the inferred geometric order.
 */
export function resolvePageBlocksForReading<
  T extends IdentifiedPositionedBlock,
>(
  page: PageBlockOrderSource<T>,
  direction: BlockReadingDirection = "rtl",
): T[] {
  const byId = new Map(page.blocks.map((block) => [block.id, block]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of page.blockOrder ?? []) {
    const block = byId.get(id);
    if (!block || seen.has(id)) continue;
    seen.add(id);
    ordered.push(block);
  }
  for (const block of sortBlocksForReading(page.blocks, direction)) {
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    ordered.push(block);
  }
  return ordered;
}

export function resolvePageBlockOrder<T extends IdentifiedPositionedBlock>(
  page: PageBlockOrderSource<T>,
  direction: BlockReadingDirection = "rtl",
): string[] {
  return resolvePageBlocksForReading(page, direction).map((block) => block.id);
}

export function inferPageBlockOrder<T extends IdentifiedPositionedBlock>(
  blocks: readonly T[],
  direction: BlockReadingDirection = "rtl",
): string[] {
  return sortBlocksForReading(blocks, direction).map((block) => block.id);
}

export function resolveReadingDirection(
  stored: StoredReadingDirection | null | undefined,
  inferred: BlockReadingDirection,
): BlockReadingDirection {
  return stored === "rtl" || stored === "ltr" ? stored : inferred;
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
