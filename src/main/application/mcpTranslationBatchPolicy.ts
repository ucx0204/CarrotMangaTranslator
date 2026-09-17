import type { ChapterSnapshot } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import { McpTranslationBatchPreviewSchema, type McpTranslationBatchPreview } from "../../shared/mcpTranslationBatch";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

export type BatchTextChange = {
  pageId: string; blockId: string; sourceText: string;
  previousText: string; proposedText: string; reason: string;
  excludedReason: string | null; changed: boolean;
};
export type BatchTextPage = {
  pageId: string; expectedRevision: string;
  state: "pending" | "applied" | "undone" | "unchanged" | "excluded";
  result: "not_started" | "saved" | "failed" | "cancelled";
  errorCode: string | null; changedBlocks: number; changes: BatchTextChange[];
};
export type BatchTextPlan = {
  workId: string; membership: string; pages: BatchTextPage[];
};
export function mcpBatchMembership(chapter: ChapterSnapshot) {
  return hashStableValue([chapter.id, chapter.workId, chapter.pageOrder, chapter.pages.map((page) => page.id)]);
}
/** Never accepts whole blocks or a replacement chapter from the AI. */
export function planMcpTranslationBatch(saved: McpContextSnapshot, input: McpTranslationBatchPreview): BatchTextPlan {
  const request = McpTranslationBatchPreviewSchema.parse(input);
  const chapter = saved.chapter;
  if (chapter.id !== request.chapterId || chapter.workId !== saved.workId)
    throw new McpEditError("not_found", "Chapter membership changed.");
  if (mcpContextRevision(saved) !== request.contextRevision)
    throw new McpEditError("revision_conflict", "Read the current work context before preparing edits.");
  if (new Set(request.pages.map((page) => page.pageId)).size !== request.pages.length ||
      request.pages.reduce((sum, page) => sum + page.edits.length, 0) > 1000)
    throw new McpEditError("invalid_edit", "Use distinct pages and at most 1000 explicit block changes.");
  const pages = request.pages.map((target) => planPage(chapter, target, request.allowEmpty));
  // Storage runs in current chapter reading order, never in a later search result's order.
  pages.sort((a, b) => chapter.pages.findIndex((page) => page.id === a.pageId) - chapter.pages.findIndex((page) => page.id === b.pageId));
  return { workId: saved.workId, membership: mcpBatchMembership(chapter), pages };
}
function planPage(chapter: ChapterSnapshot, target: McpTranslationBatchPreview["pages"][number], allowEmpty: boolean): BatchTextPage {
  const matches = chapter.pages.filter((page) => page.id === target.pageId);
  if (matches.length !== 1) throw new McpEditError("not_found", "A unique page in this chapter is required.");
  const page = matches[0];
  if (createPageRevision(page) !== target.revision)
    throw new McpEditError("revision_conflict", "A proposed page changed; read it again.");
  const blocks = new Map(page.blocks.map((block) => [block.id, block]));
  if (blocks.size !== page.blocks.length || new Set(target.edits.map((edit) => edit.blockId)).size !== target.edits.length)
    throw new McpEditError("invalid_edit", "Use unique stored and requested block IDs.");
  const changes = target.edits.map((edit): BatchTextChange => {
    const block = blocks.get(edit.blockId);
    if (!block) throw new McpEditError("not_found", "A selected block is absent from its page.");
    if (block.sourceText.length > 20000 || block.translatedText.length > 20000)
      throw new McpEditError("invalid_edit", "Stored text exceeds the review limit.");
    if (!allowEmpty && block.translatedText.trim() && !edit.translatedText.trim() && !block.generatedLettering)
      throw new McpEditError("invalid_edit", "Clearing existing text requires explicit allowEmpty; no changes were saved.");
    return { pageId: page.id, blockId: block.id, sourceText: block.sourceText,
      previousText: block.translatedText, proposedText: edit.translatedText, reason: edit.reason,
      excludedReason: block.generatedLettering ? "generated_lettering" : null,
      changed: !block.generatedLettering && block.translatedText !== edit.translatedText };
  });
  const changedBlocks = changes.filter((change) => change.changed).length;
  return { pageId: page.id, expectedRevision: target.revision, changes, changedBlocks,
    state: changedBlocks ? "pending" : changes.every((change) => change.excludedReason) ? "excluded" : "unchanged",
    result: "not_started", errorCode: null };
}
