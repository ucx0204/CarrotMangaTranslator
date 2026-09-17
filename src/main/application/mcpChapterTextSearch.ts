import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import { resolvePageBlockOrder } from "../../shared/blockReadingOrder";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import {
  McpChapterTextSearchSchema,
  type McpChapterTextSearch,
  type McpChapterTextHit,
} from "../../shared/mcpTranslationBatch";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

/** Protocol-specific bounded literal offsets, not the renderer's unbounded,
 * case-folded highlight ordinals. Offsets refer to stored UTF-16 strings. */
export function searchMcpChapterText(
  saved: McpContextSnapshot,
  input: McpChapterTextSearch,
) {
  const request = McpChapterTextSearchSchema.parse(input);
  const chapter = saved.chapter;
  validateSearchRequest(saved, request);
  const selected = selectedPages(saved, request.pageIds);
  const contextRevision = mcpContextRevision(saved);
  const { offset, limit, snapshot: expected, ...criteria } = request;
  const snapshot = hashStableValue({
    criteria,
    contextRevision,
    order: chapter.pageOrder,
    pages: chapter.pages.map((page) => [page.id, createPageRevision(page)]),
  });
  if (expected && expected !== snapshot)
    throw new McpEditError(
      "revision_conflict",
      "Search contents or criteria changed; restart at offset 0.",
    );
  const scan = {
    matches: [] as McpChapterTextHit[],
    total: 0,
    excludedGenerated: 0,
  };
  for (const [pageIndex, page] of chapter.pages.entries()) {
    if (selected.has(page.id)) collectPage(page, pageIndex, request, scan);
  }
  const { matches: result, total, excludedGenerated } = scan;
  return {
    chapterId: chapter.id,
    snapshot,
    contextRevision,
    total,
    excludedGenerated,
    offset,
    limit,
    nextOffset: offset + result.length < total ? offset + result.length : null,
    matches: result,
    note: "Literal case-sensitive stored-text offsets use UTF-16; snippets and occurrence lists may be bounded as marked. Read full blocks before writing. Candidate matches are not automatic edits. No model or file was used.",
  };
}

function selectedPages(saved: McpContextSnapshot, pageIds?: string[]) {
  const all = new Set(saved.chapter.pages.map((page) => page.id));
  if (all.size !== saved.chapter.pages.length)
    throw new McpEditError("invalid_edit", "Duplicate stored page IDs.");
  if (!pageIds) return all;
  const selected = new Set(pageIds);
  if (selected.size !== pageIds.length || pageIds.some((id) => !all.has(id)))
    throw new McpEditError(
      "invalid_edit",
      "Select distinct pages in this chapter.",
    );
  return selected;
}
function blockHit(block: TranslationBlock, request: McpChapterTextSearch) {
  const textRole: "sound" | "ordinary" =
    block.textRole === "sound" ? "sound" : "ordinary";
  const reviewStatus = block.reviewStatus ?? "draft";
  if (!matchesBlockFilters(textRole, reviewStatus, request)) return null;
  const source = occurrences(block.sourceText, "source", request);
  const translation = occurrences(block.translatedText, "translation", request);
  if (
    request.mode === "search" &&
    !source.matches.length &&
    !translation.matches.length
  )
    return null;
  return {
    blockId: block.id,
    textRole,
    reviewStatus,
    hasGeneratedLettering: Boolean(block.generatedLettering),
    editable: !block.generatedLettering,
    source: snippet(block.sourceText, source.matches[0]?.start),
    translation: snippet(block.translatedText, translation.matches[0]?.start),
    matches: [...source.matches, ...translation.matches],
    matchesTruncated: source.truncated || translation.truncated,
  };
}
function occurrences(
  text: string,
  field: "source" | "translation",
  request: McpChapterTextSearch,
) {
  const matches: McpChapterTextHit["matches"] = [];
  if (
    request.mode === "browse" ||
    (request.field !== "both" && request.field !== field)
  )
    return { matches, truncated: false };
  const query = request.query;
  if (!query)
    throw new McpEditError("invalid_edit", "Nonempty search query required.");
  if (request.match === "exact")
    return {
      matches:
        text === query ? [{ field, start: 0, end: text.length }] : matches,
      truncated: false,
    };
  let index = text.indexOf(query);
  while (index >= 0 && matches.length < 20) {
    matches.push({ field, start: index, end: index + query.length });
    index = text.indexOf(query, index + query.length);
  }
  return { matches, truncated: index >= 0 };
}
function snippet(text: string, first = 0, maximum = 800) {
  let start = Math.max(0, first - 100);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start -= 1;
  let end = Math.min(text.length, start + maximum);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
  return {
    text: text.slice(start, end),
    start,
    end,
    totalLength: text.length,
    truncated: start !== 0 || end !== text.length,
  };
}
function neighbor(block?: TranslationBlock) {
  return block
    ? {
        blockId: block.id,
        source: snippet(block.sourceText, 0, 160).text,
        translation: snippet(block.translatedText, 0, 160).text,
      }
    : null;
}

function validateSearchRequest(
  saved: McpContextSnapshot,
  request: McpChapterTextSearch,
) {
  const chapter = saved.chapter;
  if (chapter.id !== request.chapterId || chapter.workId !== saved.workId)
    throw new McpEditError("not_found", "Chapter membership changed.");
  if (
    (request.mode === "search" && !request.query?.trim()) ||
    (request.mode === "browse" && request.query !== undefined)
  )
    throw new McpEditError(
      "invalid_edit",
      "Use nonempty literal search or explicit browse mode without a query.",
    );
  if (request.offset > 0 && !request.snapshot)
    throw new McpEditError(
      "invalid_edit",
      "Subsequent windows require the first response's snapshot.",
    );
}

function collectPage(
  page: MangaPage,
  pageIndex: number,
  request: McpChapterTextSearch,
  scan: {
    matches: McpChapterTextHit[];
    total: number;
    excludedGenerated: number;
  },
) {
  const byId = new Map(page.blocks.map((block) => [block.id, block]));
  if (byId.size !== page.blocks.length)
    throw new McpEditError(
      "invalid_edit",
      "Duplicate stored block IDs must be repaired before search/edit.",
    );
  const blocks = resolvePageBlockOrder(page).map((id) => {
    const block = byId.get(id);
    if (!block)
      throw new McpEditError(
        "invalid_edit",
        "Reading order references an absent block.",
      );
    return block;
  });
  const revision = createPageRevision(page);
  for (const [index, block] of blocks.entries()) {
    const hit = blockHit(block, request);
    if (!hit) continue;
    if (hit.hasGeneratedLettering && request.generated === "exclude") {
      scan.excludedGenerated += 1;
      continue;
    }
    if (request.generated === "only" && !hit.hasGeneratedLettering) continue;
    if (scan.total >= request.offset && scan.matches.length < request.limit)
      scan.matches.push({
        ...hit,
        pageId: page.id,
        pageNumber: pageIndex + 1,
        revision,
        previous: neighbor(blocks[index - 1]),
        next: neighbor(blocks[index + 1]),
      });
    scan.total += 1;
  }
}

function matchesBlockFilters(
  textRole: string,
  reviewStatus: string,
  request: McpChapterTextSearch,
) {
  return (
    (request.textRole === "all" || request.textRole === textRole) &&
    (request.reviewStatus === "all" || request.reviewStatus === reviewStatus)
  );
}
