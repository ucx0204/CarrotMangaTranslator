import type { ChapterSnapshot } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Target = {
  pageId: string;
  revision: string;
  edits: { blockId: string }[];
};
export function mcpBatchMembership(chapter: ChapterSnapshot) {
  return hashStableValue([
    chapter.id,
    chapter.workId,
    chapter.pageOrder,
    chapter.pages.map((page) => page.id),
  ]);
}
export function validateBatchTargets(
  saved: McpContextSnapshot,
  input: { chapterId: string; contextRevision: string; pages: Target[] },
) {
  if (
    saved.chapter.id !== input.chapterId ||
    saved.chapter.workId !== saved.workId
  )
    throw new McpEditError("not_found", "Chapter membership changed.");
  if (mcpContextRevision(saved) !== input.contextRevision)
    throw new McpEditError(
      "revision_conflict",
      "Read the current work context before preparing edits.",
    );
  if (
    new Set(input.pages.map((page) => page.pageId)).size !==
      input.pages.length ||
    input.pages.reduce((sum, page) => sum + page.edits.length, 0) > 1000
  )
    throw new McpEditError(
      "invalid_edit",
      "Use distinct pages and at most 1000 explicit block changes.",
    );
}
export function requireBatchPage(chapter: ChapterSnapshot, target: Target) {
  const pages = chapter.pages.filter((page) => page.id === target.pageId);
  if (pages.length !== 1)
    throw new McpEditError(
      "not_found",
      "A unique page in this chapter is required.",
    );
  const page = pages[0];
  if (createPageRevision(page) !== target.revision)
    throw new McpEditError(
      "revision_conflict",
      "A proposed page changed; read it again.",
    );
  if (
    new Set(page.blocks.map((block) => block.id)).size !== page.blocks.length ||
    new Set(target.edits.map((edit) => edit.blockId)).size !==
      target.edits.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Use unique stored and requested block IDs.",
    );
  return page;
}
