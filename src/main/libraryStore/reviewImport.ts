import type {
  ChapterSnapshot,
  ImportReviewTextRequest,
  ImportReviewTextResult,
  ReviewStatus,
  TranslationBlock,
} from "../../shared/types";
import { parseReviewTable, type ReviewRow } from "../../shared/reviewTable";
import { hydrateChapter } from "./chapterSnapshots";
import { resolveChapterStatus } from "./chapterRecords";
import {
  findChapterLocation,
  readChapterFile,
  touchWork,
  writeChapterFile,
  type ChapterFile,
} from "./libraryFiles";

const VALID_REVIEW_STATUSES = new Set<ReviewStatus>([
  "draft",
  "needs_review",
  "reviewed",
]);

export async function applyReviewImportUnlocked(
  request: ImportReviewTextRequest,
): Promise<ImportReviewTextResult> {
  const locator = await findChapterLocation(request.chapterId);
  if (!locator) {
    throw new Error("검수표를 적용할 화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("검수표를 적용할 화를 찾지 못했습니다.");
  }

  const rows = parseReviewTable(request.content, request.format);
  const context = createImportContext(chapter);
  const changedPageIds = new Set<string>();
  let skippedRowCount = 0;
  let updatedBlockCount = 0;

  for (const [rowIndex, row] of rows.entries()) {
    const rowNumber = rowIndex + 2;
    const result = applyReviewRow({
      chapter,
      changedPageIds,
      context,
      request,
      row,
      rowNumber,
    });
    if (result === "skipped") {
      skippedRowCount += 1;
    } else if (result === "updated") {
      updatedBlockCount += 1;
    }
  }

  const saved = await saveChangedReviewPages({
    changedPageIds,
    chapter,
  });
  return {
    chapter: saved,
    updatedBlockCount,
    skippedRowCount,
    warnings: context.warnings,
  };
}

type ImportContext = {
  blockById: Map<
    string,
    { key: string; pageId: string; block: TranslationBlock }[]
  >;
  blockByScopedId: Map<
    string,
    { key: string; pageId: string; block: TranslationBlock }
  >;
  pageIds: Set<string>;
  seenBlockKeys: Set<string>;
  warnings: string[];
};

type ApplyRowInput = {
  chapter: ChapterFile;
  changedPageIds: Set<string>;
  context: ImportContext;
  request: ImportReviewTextRequest;
  row: ReviewRow;
  rowNumber: number;
};

function createImportContext(chapter: ChapterFile): ImportContext {
  const blockById = new Map<
    string,
    { key: string; pageId: string; block: TranslationBlock }[]
  >();
  const blockByScopedId = new Map<
    string,
    { key: string; pageId: string; block: TranslationBlock }
  >();
  const pageIds = new Set<string>();
  for (const page of chapter.pages) {
    pageIds.add(page.id);
    for (const block of page.blocks) {
      const key = makeBlockKey(page.id, block.id);
      const target = { key, pageId: page.id, block };
      blockByScopedId.set(key, target);
      blockById.set(block.id, [...(blockById.get(block.id) ?? []), target]);
    }
  }
  return {
    blockById,
    blockByScopedId,
    pageIds,
    seenBlockKeys: new Set<string>(),
    warnings: [],
  };
}

// CSV/TSV import has several independent validation exits; keeping them local
// makes the row policy easier to audit than scattering it across tiny wrappers.
function applyReviewRow({
  chapter,
  changedPageIds,
  context,
  request,
  row,
  rowNumber,
}: ApplyRowInput): "skipped" | "unchanged" | "updated" {
  const blockId = row.block_id.trim();
  if (!blockId) {
    context.warnings.push(`${rowNumber}행: block_id가 비어 있어 건너뜁니다.`);
    return "skipped";
  }

  const target = resolveReviewRowTarget(row, context, rowNumber);
  if (!target) {
    return "skipped";
  }
  if (context.seenBlockKeys.has(target.key)) {
    context.warnings.push(
      `${rowNumber}행: 중복 block_id ${blockId}를 건너뜁니다.`,
    );
    return "skipped";
  }
  context.seenBlockKeys.add(target.key);

  if (row.chapter_id.trim() && row.chapter_id.trim() !== chapter.id) {
    context.warnings.push(`${rowNumber}행: 다른 화의 행이라 건너뜁니다.`);
    return "skipped";
  }

  const sourceMismatch =
    row.source_text !== "" &&
    normalizeReviewCompareText(row.source_text) !==
      normalizeReviewCompareText(target.block.sourceText);
  if (sourceMismatch) {
    context.warnings.push(
      `${rowNumber}행: OCR 원문이 현재 블록과 다릅니다. block_id=${blockId}`,
    );
    if (request.requireSourceMatch) {
      return "skipped";
    }
  }

  const nextBlock = buildImportedBlock(
    target.block,
    row,
    request,
    rowNumber,
    context,
  );
  if (nextBlock === target.block) {
    return "unchanged";
  }
  replaceBlock(chapter, target.pageId, blockId, nextBlock);
  target.block = nextBlock;
  changedPageIds.add(target.pageId);
  return "updated";
}

function resolveReviewRowTarget(
  row: ReviewRow,
  context: ImportContext,
  rowNumber: number,
): { key: string; pageId: string; block: TranslationBlock } | null {
  const blockId = row.block_id.trim();
  const pageId = row.page_id.trim();
  if (pageId) {
    if (!context.pageIds.has(pageId)) {
      context.warnings.push(
        `${rowNumber}행: 없는 page_id ${row.page_id}입니다.`,
      );
    }
    const scopedTarget = context.blockByScopedId.get(
      makeBlockKey(pageId, blockId),
    );
    if (scopedTarget) {
      return scopedTarget;
    }
  }

  const targets = context.blockById.get(blockId) ?? [];
  if (targets.length === 0) {
    context.warnings.push(`${rowNumber}행: 없는 block_id ${blockId}입니다.`);
    return null;
  }
  if (targets.length > 1) {
    context.warnings.push(
      `${rowNumber}행: block_id ${blockId}가 여러 페이지에 있어 page_id와 함께 찾지 못하면 건너뜁니다.`,
    );
    return null;
  }
  const [target] = targets;
  if (pageId && pageId !== target.pageId) {
    context.warnings.push(
      `${rowNumber}행: page_id가 현재 블록 위치와 다릅니다. block_id 기준으로 적용합니다.`,
    );
  }
  return target;
}

function makeBlockKey(pageId: string, blockId: string): string {
  return `${pageId}\u0000${blockId}`;
}

function normalizeReviewCompareText(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC");
}

function buildImportedBlock(
  block: TranslationBlock,
  row: ReviewRow,
  request: ImportReviewTextRequest,
  rowNumber: number,
  context: ImportContext,
): TranslationBlock {
  const status = normalizeReviewStatus(row.review_status);
  if (row.review_status.trim() && !status) {
    context.warnings.push(
      `${rowNumber}행: 검수 상태 ${row.review_status}는 사용할 수 없습니다.`,
    );
  }

  const next: TranslationBlock = {
    ...block,
    translatedText: row.translated_text,
    reviewNote: row.review_note,
    ...(status ? { reviewStatus: status } : {}),
    ...(request.updateSourceText ? { sourceText: row.source_text } : {}),
  };

  return isSameImportedBlock(block, next) ? block : next;
}

function normalizeReviewStatus(value: string): ReviewStatus | null {
  const normalized = value.trim() as ReviewStatus;
  return VALID_REVIEW_STATUSES.has(normalized) ? normalized : null;
}

function isSameImportedBlock(
  left: TranslationBlock,
  right: TranslationBlock,
): boolean {
  return (
    left.sourceText === right.sourceText &&
    left.translatedText === right.translatedText &&
    left.reviewStatus === right.reviewStatus &&
    (left.reviewNote ?? "") === (right.reviewNote ?? "")
  );
}

function replaceBlock(
  chapter: ChapterFile,
  pageId: string,
  blockId: string,
  nextBlock: TranslationBlock,
): void {
  chapter.pages = chapter.pages.map((page) =>
    page.id === pageId
      ? {
          ...page,
          blocks: page.blocks.map((block) =>
            block.id === blockId ? nextBlock : block,
          ),
        }
      : page,
  );
}

async function saveChangedReviewPages({
  changedPageIds,
  chapter,
}: {
  changedPageIds: Set<string>;
  chapter: ChapterFile;
}): Promise<ChapterSnapshot> {
  if (changedPageIds.size === 0) {
    return hydrateChapter(chapter);
  }
  const now = new Date().toISOString();
  const pages = chapter.pages.map((page) =>
    changedPageIds.has(page.id) ? { ...page, updatedAt: now } : page,
  );
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now,
  };
  await writeChapterFile(nextChapter);
  await touchWork(nextChapter.workId, now);
  return hydrateChapter(nextChapter);
}
