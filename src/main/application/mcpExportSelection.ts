import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type {
  McpBatchExportOptions,
  McpExportPagesTarget,
  McpExportSourceName,
} from "../../shared/mcpExportBatch";
import {
  mcpPageOutputFormat,
  type McpPageExportOptions,
  type McpRasterExportOptions,
} from "../../shared/mcpOutputFormats";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";

export type McpExportSourceNameReader = (
  page: MangaPage,
) => McpExportSourceName;

/** Preserve old fingerprints; only source-policy snapshots bind saved-name evidence. */
export function mcpExportSnapshot(
  chapter: ChapterSnapshot,
  imageExport?: McpBatchExportOptions,
  sourcePages?: ReturnType<typeof selectMcpExportPages>,
): string {
  if (imageExport?.format === "source" && !sourcePages?.length)
    throw new McpEditError(
      "invalid_edit",
      "Source-format review evidence is required.",
    );
  return hashStableValue({
    chapterId: chapter.id,
    workId: chapter.workId,
    pageOrder: chapter.pageOrder,
    pageIds: chapter.pages.map((page) => page.id),
    ...(imageExport ? { imageExport } : {}),
    ...(imageExport?.format === "source"
      ? {
          sourcePlan: sourcePages?.map((page) => ({
            pageId: page.pageId,
            pageIndex: page.pageIndex,
            filename: page.filename,
            sourceNameFingerprint: page.sourceNameFingerprint,
            imageExport: page.imageExport,
            sourceFormatBasis: page.sourceFormatBasis,
            fallback: page.fallback,
          })),
        }
      : {}),
  });
}
export function selectMcpExportPages(
  chapter: ChapterSnapshot,
  pageIds?: string[],
  imageExport?: McpBatchExportOptions,
  readSourceName?: McpExportSourceNameReader,
) {
  const ids = pageIds ?? chapter.pages.map((page) => page.id);
  const selected = new Set(ids);
  if (!ids.length || ids.length > 50 || selected.size !== ids.length)
    throw new McpEditError(
      "invalid_edit",
      "Select 1 to 50 distinct pages in one chapter.",
    );
  const pages = chapter.pages.flatMap((page, pageIndex) => {
    if (!selected.has(page.id)) return [];
    const { format, ...source } = resolveSourcePage(
      page,
      imageExport,
      readSourceName,
    );
    const extension = mcpPageOutputFormat(format).extension;
    return [
      {
        pageId: page.id,
        pageIndex,
        revision: createPageRevision(page),
        filename: `${String(pageIndex + 1).padStart(4, "0")}.${extension}`,
        width: page.width,
        height: page.height,
        ...source,
      },
    ];
  });
  if (pages.length !== ids.length)
    throw new McpEditError(
      "not_found",
      "A selected page does not belong to this chapter.",
    );
  return pages;
}
function resolveSourcePage(
  page: MangaPage,
  policy: McpBatchExportOptions | undefined,
  readSourceName: McpExportSourceNameReader | undefined,
): {
  format: McpPageExportOptions["format"];
  imageExport?: McpRasterExportOptions;
  sourceNameFingerprint?: string;
  sourceFormatBasis?: "saved-source-name";
  fallback?: McpExportSourceName["fallback"];
} {
  if (policy?.format !== "source") return { format: policy?.format ?? "png" };
  if (!readSourceName)
    throw new McpEditError(
      "invalid_edit",
      "Native source-format evidence is unavailable.",
    );
  const source = readSourceName(page);
  if (source.fallback !== "none" && policy.unsupportedSource === "reject")
    throw new McpEditError(
      "invalid_edit",
      "A selected saved source name has an unsupported image extension. Review an explicit PNG fallback or choose a concrete output format.",
    );
  return {
    format: source.format,
    sourceNameFingerprint: source.sourceNameFingerprint,
    imageExport: {
      format: source.format,
      omitText: policy.omitText,
      ...(source.format === "jpeg"
        ? { quality: policy.jpegQuality }
        : source.format === "webp"
          ? { quality: policy.webpQuality }
          : {}),
    },
    sourceFormatBasis: "saved-source-name",
    fallback: source.fallback,
  };
}
/** Public metadata never includes the saved-name digest or native source paths. */
export function mcpExportPageMetadata(
  page: ReturnType<typeof selectMcpExportPages>[number],
) {
  return {
    pageId: page.pageId,
    pageIndex: page.pageIndex,
    revision: page.revision,
    filename: page.filename,
    width: page.width,
    height: page.height,
    ...(page.imageExport
      ? {
          imageExport: page.imageExport,
          sourceFormatBasis: page.sourceFormatBasis,
          fallback: page.fallback,
        }
      : {}),
  };
}
export function assertMcpExportSelection(
  chapter: ChapterSnapshot,
  target: McpExportPagesTarget,
  readSourceName?: McpExportSourceNameReader,
  snapshotPageIds?: string[],
) {
  const sourcePages =
    target.imageExport?.format === "source"
      ? selectMcpExportPages(
          chapter,
          snapshotPageIds ?? target.pages.map((page) => page.pageId),
          target.imageExport,
          readSourceName,
        )
      : undefined;
  if (
    chapter.id !== target.chapterId ||
    mcpExportSnapshot(chapter, target.imageExport, sourcePages) !==
      target.snapshot
  )
    throw new McpEditError(
      "revision_conflict",
      "Chapter membership, page order, source naming or output options changed. Run export preflight again.",
    );
  const pages =
    sourcePages && !snapshotPageIds
      ? sourcePages
      : selectMcpExportPages(
          chapter,
          target.pages.map((page) => page.pageId),
          target.imageExport,
          readSourceName,
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
