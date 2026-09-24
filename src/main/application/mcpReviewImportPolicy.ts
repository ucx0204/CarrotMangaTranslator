import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { parseReviewDocument, type ReviewRow } from "../../shared/reviewTable";
import { planReviewImport } from "../../shared/reviewImportPlan";
import {
  McpTextImportFieldsSchema,
  type McpTextImportChange,
  type McpTextImportDiagnostic,
  type McpTextImportPreview,
} from "../../shared/mcpTextExchange";
import { McpEditError } from "./mcpEditPolicy";

type Fields = Pick<
  TranslationBlock,
  "sourceText" | "translatedText" | "reviewStatus" | "reviewNote"
>;
export type TextImportSnapshotRequest = {
  chapterId: string;
  pageId: string;
  revision: string;
  pageName: string;
  fields: { blockId: string; value: Fields }[];
};
export function projectReviewImportFields(block: TranslationBlock): Fields {
  const fields = {
    sourceText: block.sourceText,
    translatedText: block.translatedText,
    ...(block.reviewStatus === undefined
      ? {}
      : { reviewStatus: block.reviewStatus }),
    ...(block.reviewNote === undefined ? {} : { reviewNote: block.reviewNote }),
  };
  if (!McpTextImportFieldsSchema.safeParse(fields).success)
    throw new McpEditError(
      "invalid_edit",
      "Review text fields exceed existing editable-field limits; no text was clipped.",
    );
  return fields;
}

/** MCP admission surrounds the same native row planner; fallback never authorizes another page. */
export function planMcpReviewFile(
  chapter: ChapterSnapshot,
  input: McpTextImportPreview,
  content: string,
) {
  const format = input.source.options.format;
  if (format === "txt")
    throw new McpEditError("invalid_edit", "Review tables require CSV or TSV.");
  const document = parseReviewDocument(content, format);
  if (
    document.rows.length > 1000 ||
    document.ignoredColumns.length > 100 ||
    document.ignoredColumns.some((name) => name.length > 240) ||
    document.duplicateColumns.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Review at most 1000 rows and 100 bounded extra columns; duplicate headers are ambiguous.",
    );
  const selected = new Map(
    input.selection.map((page) => [page.pageId, new Set(page.blockIds)]),
  );
  const scoped = {
    ...chapter,
    pages: chapter.pages.filter((page) => selected.has(page.id)),
  };
  const native = planReviewImport(scoped, document.rows, input);
  const diagnostics: McpTextImportDiagnostic[] = [
    ...document.ignoredColumns.map((field) => ({
      code: "unsupported_column_ignored",
      field,
    })),
    ...native.diagnostics.map(({ key, values }) => ({
      code: key,
      row: Number(values.row),
    })),
  ];
  const changes = new Map<string, TranslationBlock>();
  for (const [index, row] of native.rows.entries()) {
    const uploaded = document.rows[index];
    if (!admittedRow(uploaded, chapter.id, selected, row.pageId)) {
      diagnostics.push({
        code: "row_outside_explicit_selection",
        row: row.rowNumber,
      });
      continue;
    }
    if (row.result === "updated" && row.after && row.pageId)
      changes.set(blockKey(row.pageId, row.blockId), row.after);
  }
  return { changes, diagnostics };
}
function admittedRow(
  row: ReviewRow,
  chapterId: string,
  selected: Map<string, Set<string>>,
  resolvedPage: string | null,
) {
  return (
    row.chapter_id.trim() === chapterId &&
    (resolvedPage === null || row.page_id.trim() === resolvedPage) &&
    Boolean(selected.get(row.page_id.trim())?.has(row.block_id.trim()))
  );
}
export function reviewFileChange(
  page: MangaPage,
  block: TranslationBlock,
  next: TranslationBlock,
  allowEmpty: boolean,
): McpTextImportChange {
  const before = projectReviewImportFields(block);
  const after = projectReviewImportFields(next);
  if (!allowEmpty && clearsText(before, after))
    throw new McpEditError(
      "invalid_edit",
      "Clearing source, translation or review notes requires explicit allowEmpty.",
    );
  return {
    pageId: page.id,
    blockId: block.id,
    before,
    after,
    changed: block !== next,
    excludedReason: null,
    warnings: block.generatedLettering
      ? ["generated_lettering_image_preserved_text_fields_only"]
      : [],
  };
}
function clearsText(before: Fields, after: Fields) {
  return (["sourceText", "translatedText", "reviewNote"] as const).some(
    (field) => Boolean(before[field]?.trim()) && !after[field]?.trim(),
  );
}
export function blockKey(pageId: string, blockId: string) {
  return `${pageId}\u0000${blockId}`;
}

/** Only four app-calculated scalar fields cross this internal commit port. */
export function applyMcpTextImportSnapshots(
  page: MangaPage,
  request: TextImportSnapshotRequest,
) {
  assertTextImportPageName(page, request.pageName);
  const targets = new Map(
    request.fields.map((field) => [field.blockId, field.value]),
  );
  if (!targets.size || targets.size !== request.fields.length)
    throw new McpEditError(
      "invalid_edit",
      "Distinct reviewed text targets are required.",
    );
  for (const [id, value] of targets) {
    if (!page.blocks.some((block) => block.id === id))
      throw new McpEditError("not_found", "A reviewed text target is absent.");
    if (!McpTextImportFieldsSchema.safeParse(value).success)
      throw new McpEditError(
        "invalid_edit",
        "Reviewed text fields no longer satisfy scalar limits.",
      );
  }
  return page.blocks.map((block) => {
    const fields = targets.get(block.id);
    if (!fields) return block;
    const {
      sourceText: _source,
      translatedText: _translation,
      reviewStatus: _status,
      reviewNote: _note,
      ...protectedFields
    } = block;
    return { ...protectedFields, ...structuredClone(fields) };
  });
}
export function assertTextImportPageName(page: MangaPage, expected: string) {
  if (page.name !== expected)
    throw new McpEditError(
      "revision_conflict",
      "A reviewed page name changed; prepare the remaining import again.",
    );
}
