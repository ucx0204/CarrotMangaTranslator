import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision } from "../../shared/pageRevision";
import { resolveReadingDirection } from "../../shared/blockReadingOrder";
import { resolveSourceReadingDirection } from "../../shared/translationLanguages";
import {
  gatherText,
  filterPagesByField,
  formatGatheredText,
} from "../../shared/gatherText";
import { buildReviewRows, serializeReviewRows } from "../../shared/reviewTable";
import {
  MCP_EXCHANGE_BYTES,
  McpTextExchangeBindingSchema,
  type McpTextExchangeBinding,
} from "../../shared/mcpExchangeFiles";
import {
  McpTextExportReviewInputSchema,
  McpTextExportReviewOutputSchema,
  type McpTextExportReviewInput,
} from "../../shared/mcpTextExchange";
import { McpEditError } from "../application/mcpEditPolicy";
import { withLibraryRead } from "../library/lock";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
} from "../libraryStore/libraryFiles";
import { hydrateChapter } from "../libraryStore/chapterSnapshots";
import { getAppSettings } from "../settingsStore";

/** Reads saved metadata/text only; no image files, checkpoints, renderers or model. */
export async function readMcpTextExportSource(
  input: McpTextExportReviewInput,
  guard: () => void,
  signal?: AbortSignal,
) {
  const state = await withLibraryRead(() => readUnlocked(input, guard, signal));
  return {
    ...state,
    verifySources: () =>
      checkMcpTextExchangeBinding(state.binding, guard, signal),
  };
}

export function checkMcpTextExchangeBinding(
  binding: McpTextExchangeBinding,
  guard?: () => void,
  signal?: AbortSignal,
) {
  return withLibraryRead(() =>
    checkMcpTextExchangeBindingUnlocked(binding, guard, signal),
  );
}
/** Publication calls this inside the existing library mutation; never relock. */
export async function checkMcpTextExchangeBindingUnlocked(
  value: McpTextExchangeBinding,
  guard?: () => void,
  signal?: AbortSignal,
) {
  const binding = McpTextExchangeBindingSchema.parse(value);
  const current = await readUnlocked(
    {
      chapterId: binding.chapterId,
      pageIds: binding.pages.map((page) => page.pageId),
      options: binding.options,
    },
    guard,
    signal,
  );
  if (hashStableValue(current.binding) !== hashStableValue(binding))
    throw new McpEditError(
      "revision_conflict",
      "Saved text export source changed. Repeat preflight.",
    );
}

async function readUnlocked(
  value: McpTextExportReviewInput,
  guard?: () => void,
  signal?: AbortSignal,
) {
  check(guard, signal);
  const input = McpTextExportReviewInputSchema.parse(value);
  const locator = await findChapterLocation(input.chapterId);
  if (!locator)
    throw new McpEditError("not_found", "Saved chapter is unavailable.");
  const [stored, work, settings] = await Promise.all([
    readChapterFile(locator.workId, locator.chapterId),
    readWorkFile(locator.workId),
    getAppSettings(),
  ]);
  check(guard, signal);
  if (!stored || !work || !work.chapterOrder.includes(stored.id))
    throw new McpEditError("not_found", "Saved chapter membership changed.");
  const chapter = hydrateChapter(stored);
  const pages = selectPages(chapter, input.pageIds);
  const inferred = resolveSourceReadingDirection(
    settings.translation?.sourceLanguage,
  );
  const direction =
    input.options.format === "txt"
      ? resolveReadingDirection(work.readingDirection, inferred)
      : inferred;
  const result = prepareExport(chapter, pages, work.id, direction, input);
  check(guard, signal);
  return result;
}

function prepareExport(
  chapter: ChapterSnapshot,
  pages: MangaPage[],
  workId: string,
  direction: "ltr" | "rtl",
  input: McpTextExportReviewInput,
) {
  const serialized = serializeSelection(
    chapter,
    pages,
    input.options,
    direction,
  );
  const bytes = Buffer.from(serialized.content, "utf8");
  if (bytes.length > MCP_EXCHANGE_BYTES)
    throw new McpEditError(
      "invalid_edit",
      "Text output exceeds 4 MiB UTF-8; select fewer pages. Nothing was truncated.",
    );
  const binding = McpTextExchangeBindingSchema.parse({
    kind: "text",
    workId,
    chapterId: chapter.id,
    direction,
    pages: pages.map((page) => ({
      pageId: page.id,
      revision: createPageRevision(page),
    })),
    options: input.options,
    snapshot: hashStableValue({
      workId,
      chapterId: chapter.id,
      options: input.options,
      direction,
      pages: pages.map((page) => ({
        id: page.id,
        index: chapter.pages.findIndex((item) => item.id === page.id),
        name: page.name,
        order: page.blockOrder ?? null,
      })),
      serializerInput: serialized.input,
    }),
  });
  const review = reviewForBinding(binding, bytes.length, serialized);
  return { binding, review, bytes };
}

function reviewForBinding(
  binding: McpTextExchangeBinding,
  bytes: number,
  counts: { blockCount: number; rowCount: number },
) {
  return McpTextExportReviewOutputSchema.parse({
    binding,
    bytes,
    pageCount: binding.pages.length,
    blockCount: counts.blockCount,
    rowCount: counts.rowCount,
    omissions: [
      "images_geometry_typography_and_context_are_not_text_exchange_fields",
    ],
    warnings:
      binding.options.format === "txt"
        ? [
            "native_txt_trims_text_and_filters_empty_fields",
            "txt_import_uses_reviewed_positional_mapping",
          ]
        : [
            "native_review_table_preserves_literal_cells",
            "indices_and_identity_columns_are_not_editable_fields",
          ],
    executionReserved: false,
  });
}

function selectPages(chapter: ChapterSnapshot, ids?: string[]) {
  const wanted = ids ? new Set(ids) : null;
  const pages = chapter.pages.filter((page) => !wanted || wanted.has(page.id));
  if (
    !pages.length ||
    pages.length > 50 ||
    (ids && (wanted?.size !== ids.length || pages.length !== ids.length))
  )
    throw new McpEditError(
      "invalid_edit",
      "Select one to fifty distinct existing pages; no selection was truncated.",
    );
  return pages;
}
function serializeSelection(
  chapter: ChapterSnapshot,
  pages: MangaPage[],
  options: McpTextExchangeBinding["options"],
  direction: "ltr" | "rtl",
) {
  if (options.format === "txt") {
    const gathered = pages.flatMap((page) =>
      gatherText({ chapter, page, scope: "page", direction }),
    );
    const selected = filterPagesByField(gathered, options.field);
    return {
      content: formatGatheredText(
        selected,
        options.field,
        options.includeHeaders,
      ),
      input: selected,
      blockCount: selected.reduce((sum, page) => sum + page.blocks.length, 0),
      rowCount: 0,
    };
  }
  const rows = buildReviewRows(
    chapter,
    direction,
    new Set(pages.map((page) => page.id)),
  );
  return {
    content: serializeReviewRows(rows, options.format, options.includeBom),
    input: rows,
    blockCount: rows.length,
    rowCount: rows.length,
  };
}
function check(guard?: () => void, signal?: AbortSignal) {
  signal?.throwIfAborted();
  guard?.();
}
