import type { MangaPage } from "../../shared/libraryTypes";
import type { McpTranslationPatch } from "../../shared/mcpEditingTypes";

export class McpEditError extends Error {
  constructor(
    readonly code:
      | "revision_conflict"
      | "editor_busy"
      | "not_found"
      | "invalid_edit"
      | "access_denied",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
/** Only these public text and geometry fields leave the app. No artifacts or paths. */
export function projectMcpBlocks(
  page: MangaPage,
  offset: number,
  limit: number,
) {
  return page.blocks.slice(offset, offset + limit).map((block) => ({
    id: block.id,
    sourceText: block.sourceText,
    translatedText: block.translatedText,
    bbox: block.bbox,
    bboxSpace: block.bboxSpace,
    renderBbox: block.renderBbox,
    renderBboxSpace: block.renderBboxSpace,
    textRole: block.textRole,
    sourceDirection: block.sourceDirection,
    renderDirection: block.renderDirection,
    fontSizePx: block.fontSizePx,
    reviewStatus: block.reviewStatus,
    hasGeneratedLettering: Boolean(block.generatedLettering),
  }));
}
/** Patch existing text only; never rebuild an internal block from an AI object. */
export function applyMcpTranslations(
  page: MangaPage,
  edits: McpTranslationPatch["edits"],
) {
  const byId = new Map(
    edits.map((edit) => [edit.blockId, edit.translatedText]),
  );
  if (!edits.length || byId.size !== edits.length)
    throw new McpEditError(
      "invalid_edit",
      "Provide distinct existing block IDs.",
    );
  const known = new Set(page.blocks.map((block) => block.id));
  if ([...byId.keys()].some((id) => !known.has(id)))
    throw new McpEditError(
      "not_found",
      "A requested block no longer exists. Read this page again.",
    );
  const previous = page.blocks
    .filter(
      (block) =>
        byId.has(block.id) && block.translatedText !== byId.get(block.id),
    )
    .map((block) => ({
      blockId: block.id,
      translatedText: block.translatedText,
    }));
  const blocks = page.blocks.map((block) =>
    byId.has(block.id)
      ? { ...block, translatedText: byId.get(block.id) ?? block.translatedText }
      : block,
  );
  return { blocks, previous };
}
export function isMcpSaveConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("페이지가 다른 작업으로 갱신되었습니다")
  );
}
