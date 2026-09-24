import type { TranslationBlock, ReviewStatus } from "./textTypes";
import type { ReviewRow } from "./reviewTable";

type Chapter = {
  id: string;
  pages: readonly { id: string; blocks: readonly TranslationBlock[] }[];
};
type Options = { updateSourceText?: boolean; requireSourceMatch?: boolean };
type WarningCode =
  | "emptyBlockId"
  | "duplicateBlockId"
  | "otherChapter"
  | "sourceMismatch"
  | "pageNotFound"
  | "blockNotFound"
  | "ambiguousBlock"
  | "pageMismatch"
  | "invalidStatus";
type ReviewImportDiagnostic = {
  key: `reviewImport.warnings.${WarningCode}`;
  values: Record<string, string | number>;
};
type Target = { key: string; pageId: string; block: TranslationBlock };
type Context = {
  blockById: Map<string, Target[]>;
  blockByScopedId: Map<string, Target>;
  pageIds: Set<string>;
  seenBlockKeys: Set<string>;
  diagnostics: ReviewImportDiagnostic[];
};
export type ReviewImportRowPlan = {
  rowNumber: number;
  result: "skipped" | "unchanged" | "updated";
  pageId: string | null;
  blockId: string;
  before: TranslationBlock | null;
  after: TranslationBlock | null;
};

/** Native row policy only. Callers retain their existing save/ownership authority. */
export function planReviewImport(
  chapter: Chapter,
  rows: ReviewRow[],
  options: Options,
) {
  const context = createImportContext(chapter);
  const planned = rows.map((row, index) =>
    planRow(chapter.id, row, index + 2, context, options),
  );
  return {
    rows: planned,
    diagnostics: context.diagnostics,
    updatedBlockCount: planned.filter((row) => row.result === "updated").length,
    skippedRowCount: planned.filter((row) => row.result === "skipped").length,
  };
}

function createImportContext(chapter: Chapter): Context {
  const blockById = new Map<string, Target[]>();
  const blockByScopedId = new Map<string, Target>();
  const pageIds = new Set<string>();
  for (const page of chapter.pages) {
    pageIds.add(page.id);
    for (const block of page.blocks) {
      const key = makeBlockKey(page.id, block.id);
      const target = { key, pageId: page.id, block };
      blockByScopedId.set(key, target);
      const matches = blockById.get(block.id);
      if (matches) matches.push(target);
      else blockById.set(block.id, [target]);
    }
  }
  return {
    blockById,
    blockByScopedId,
    pageIds,
    seenBlockKeys: new Set(),
    diagnostics: [],
  };
}

function planRow(
  chapterId: string,
  row: ReviewRow,
  rowNumber: number,
  context: Context,
  options: Options,
): ReviewImportRowPlan {
  const target = claimTarget(row, rowNumber, context);
  const result: ReviewImportRowPlan = {
    rowNumber,
    result: "skipped",
    pageId: target?.pageId ?? null,
    blockId: row.block_id.trim(),
    before: target?.block ?? null,
    after: null,
  };
  if (
    !target ||
    !acceptSource(chapterId, row, rowNumber, target, context, options)
  )
    return result;
  const next = buildImportedBlock(
    target.block,
    row,
    options,
    rowNumber,
    context,
  );
  result.result = next === target.block ? "unchanged" : "updated";
  result.after = next;
  target.block = next;
  return result;
}

function claimTarget(row: ReviewRow, rowNumber: number, context: Context) {
  const blockId = row.block_id.trim();
  if (!blockId) {
    warn(context, "emptyBlockId", { row: rowNumber });
    return null;
  }
  const target = resolveReviewRowTarget(row, context, rowNumber);
  if (!target) return null;
  if (context.seenBlockKeys.has(target.key)) {
    warn(context, "duplicateBlockId", { row: rowNumber, blockId });
    return null;
  }
  // Preserve desktop semantics: an identified row claims its target even if
  // later chapter/source validation skips that row.
  context.seenBlockKeys.add(target.key);
  return target;
}

function acceptSource(
  chapterId: string,
  row: ReviewRow,
  rowNumber: number,
  target: Target,
  context: Context,
  options: Options,
) {
  if (row.chapter_id.trim() && row.chapter_id.trim() !== chapterId) {
    warn(context, "otherChapter", { row: rowNumber });
    return false;
  }
  const sourceMismatch =
    row.source_text !== "" &&
    normalizeReviewCompareText(row.source_text) !==
      normalizeReviewCompareText(target.block.sourceText);
  if (sourceMismatch) {
    warn(context, "sourceMismatch", {
      row: rowNumber,
      blockId: row.block_id.trim(),
    });
    if (options.requireSourceMatch) return false;
  }
  return true;
}

function resolveReviewRowTarget(
  row: ReviewRow,
  context: Context,
  rowNumber: number,
) {
  const blockId = row.block_id.trim();
  const pageId = row.page_id.trim();
  if (pageId) {
    if (!context.pageIds.has(pageId))
      warn(context, "pageNotFound", { row: rowNumber, pageId: row.page_id });
    const scoped = context.blockByScopedId.get(makeBlockKey(pageId, blockId));
    if (scoped) return scoped;
  }
  return resolveGlobalTarget(row, context, rowNumber);
}

function resolveGlobalTarget(
  row: ReviewRow,
  context: Context,
  rowNumber: number,
) {
  const blockId = row.block_id.trim();
  const pageId = row.page_id.trim();
  const targets = context.blockById.get(blockId) ?? [];
  if (!targets.length) {
    warn(context, "blockNotFound", { row: rowNumber, blockId });
    return null;
  }
  if (targets.length > 1) {
    warn(context, "ambiguousBlock", { row: rowNumber, blockId });
    return null;
  }
  const [target] = targets;
  if (pageId && pageId !== target.pageId)
    warn(context, "pageMismatch", { row: rowNumber });
  return target;
}

function makeBlockKey(pageId: string, blockId: string) {
  return `${pageId}\u0000${blockId}`;
}
function normalizeReviewCompareText(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC");
}

const VALID_REVIEW_STATUSES = new Set<ReviewStatus>([
  "draft",
  "needs_review",
  "reviewed",
]);
function buildImportedBlock(
  block: TranslationBlock,
  row: ReviewRow,
  options: Options,
  rowNumber: number,
  context: Context,
) {
  const normalized = row.review_status.trim() as ReviewStatus;
  const status = VALID_REVIEW_STATUSES.has(normalized) ? normalized : null;
  if (row.review_status.trim() && !status)
    warn(context, "invalidStatus", {
      row: rowNumber,
      status: row.review_status,
    });
  const next: TranslationBlock = {
    ...block,
    translatedText: row.translated_text,
    reviewNote: row.review_note,
    ...(status ? { reviewStatus: status } : {}),
    ...(options.updateSourceText ? { sourceText: row.source_text } : {}),
  };
  return isSameImportedBlock(block, next) ? block : next;
}
function isSameImportedBlock(left: TranslationBlock, right: TranslationBlock) {
  return (
    left.sourceText === right.sourceText &&
    left.translatedText === right.translatedText &&
    left.reviewStatus === right.reviewStatus &&
    (left.reviewNote ?? "") === (right.reviewNote ?? "")
  );
}
function warn(
  context: Context,
  code: WarningCode,
  values: Record<string, string | number>,
) {
  context.diagnostics.push({ key: `reviewImport.warnings.${code}`, values });
}
