import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type { McpExportPagesTarget } from "../../shared/mcpExportBatch";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";

/** Membership and complete reading order are pinned, not unrelated page text. */
export function mcpExportSnapshot(chapter: ChapterSnapshot): string {
  return hashStableValue({
    chapterId: chapter.id,
    workId: chapter.workId,
    pageOrder: chapter.pageOrder,
    pageIds: chapter.pages.map((page) => page.id),
  });
}
export function selectMcpExportPages(
  chapter: ChapterSnapshot,
  pageIds?: string[],
) {
  const ids = pageIds ?? chapter.pages.map((page) => page.id);
  const selected = new Set(ids);
  if (!ids.length || ids.length > 50 || selected.size !== ids.length)
    throw new McpEditError(
      "invalid_edit",
      "Select 1 to 50 distinct pages in one chapter.",
    );
  const pages = chapter.pages.flatMap((page, pageIndex) =>
    selected.has(page.id)
      ? [
          {
            pageId: page.id,
            pageIndex,
            revision: createPageRevision(page),
            filename: `${String(pageIndex + 1).padStart(4, "0")}.png`,
            width: page.width,
            height: page.height,
          },
        ]
      : [],
  );
  if (pages.length !== ids.length)
    throw new McpEditError(
      "not_found",
      "A selected page does not belong to this chapter.",
    );
  return pages;
}
export function assertMcpExportSelection(
  chapter: ChapterSnapshot,
  target: McpExportPagesTarget,
) {
  if (
    chapter.id !== target.chapterId ||
    mcpExportSnapshot(chapter) !== target.snapshot
  )
    throw new McpEditError(
      "revision_conflict",
      "Chapter membership or page order changed. Run export preflight again.",
    );
  const pages = selectMcpExportPages(
    chapter,
    target.pages.map((page) => page.pageId),
  );
  if (
    pages.some(
      (page, index) =>
        page.pageId !== target.pages[index]?.pageId ||
        page.revision !== target.pages[index]?.revision,
    )
  )
    throw new McpEditError(
      "revision_conflict",
      "Selected pages changed or are not in chapter order. Run export preflight again.",
    );
  return pages;
}
