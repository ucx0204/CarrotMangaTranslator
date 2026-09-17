import { z } from "zod/v4";
import { McpExportPagesMetadataSchema } from "../../shared/mcpExportBatch";
import { McpEditError } from "./mcpEditPolicy";

type Entry = {
  settled: boolean;
  status: string;
  kind: string;
  result?: Record<string, unknown>;
};
const retainedPages = McpExportPagesMetadataSchema.extend({
  pages: z
    .array(
      McpExportPagesMetadataSchema.shape.pages.element.extend({
        url: z.string().url().optional(),
      }),
    )
    .max(50),
});
export function mcpExportSource(entry: Entry) {
  if (
    !entry.settled ||
    entry.kind !== "exportPages" ||
    !entry.result?.exportPages
  )
    throw unavailable();
  return {
    status: entry.status,
    data: retainedPages.parse(entry.result.exportPages),
  };
}
export function mcpOperationFile(
  entry: Entry,
  pageId?: string,
): Record<string, unknown> {
  if (entry.kind === "exportPages") {
    if (!pageId)
      throw new McpEditError(
        "invalid_edit",
        "Select an exported pageId, or explicitly create a ZIP from this job.",
      );
    const source = mcpExportSource(entry);
    const page = source.data.pages.find((item) => item.pageId === pageId);
    if (!page || page.status !== "exported" || !page.url) throw unavailable();
    return {
      ...page,
      kind: "rendered-page-png",
      chapterId: source.data.chapterId,
      mimeType: "image/png",
      access:
        "single-file-link; expires on stop, revocation, page change or redaction change",
    };
  }
  return singleFile(entry, pageId);
}
function singleFile(entry: Entry, pageId?: string): Record<string, unknown> {
  const validKind =
    (entry.kind === "exportPng" &&
      entry.result?.kind === "rendered-page-png") ||
    (entry.kind === "exportZip" && entry.result?.kind === "rendered-pages-zip");
  if (
    pageId ||
    !entry.settled ||
    entry.status !== "completed" ||
    !validKind ||
    typeof entry.result?.url !== "string"
  )
    throw unavailable();
  return structuredClone(entry.result);
}
function unavailable() {
  return new McpEditError(
    "not_found",
    "Completed output is unavailable. Explicitly export the current page again, or inspect the page batch and create its ZIP.",
  );
}
