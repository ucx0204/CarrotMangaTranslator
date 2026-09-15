import { McpReviewService } from "../application/mcpReviewService";
import type { PageImageExportRepository } from "../jobs/pageImageExportPorts";
import { preflightPageImageExport } from "../jobs/pageImageExportSelection";
import { mcpReviewFilter } from "../../shared/mcpReviewSchemas";
import {
  allowArguments,
  identifierSchema,
  McpInvalidParams,
  readIdentifier,
  readWindow,
  windowProperties,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

/** Metadata-only adapter: reuse app selection/preflight, never an export executor.
 * Pin the inspected chapter so both review counts and app rules use one version. */
export function createMcpReviewTools(
  repository: PageImageExportRepository,
): McpTool[] {
  const service = new McpReviewService({
    openChapter: repository.openChapter,
    preflight: (chapter, pageId) =>
      preflightPageImageExport(
        {
          workId: chapter.workId,
          selections: [
            { chapterId: chapter.id, mode: "page-set", pageIds: [pageId] },
          ],
          outputFormat: "png",
          omitText: false,
        },
        {
          listLibrary: repository.listLibrary,
          openChapter: async () => chapter,
        },
      ),
  });
  return [chapterReviewTool(service), exportPreflightTool(service)];
}
function chapterReviewTool(service: McpReviewService): McpTool {
  return {
    name: "carrot_get_chapter_review",
    requiredScopes: ["carrot.read"],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    description:
      "Inspect SAVED chapter metadata for untranslated/unreviewed blocks, failed or pending stages and stale generated lettering. Filter before pagination; summary covers the entire chapter. Start at offset 0, then send the returned snapshot with each later page. No images, text contents, models, mutations or quality judgment. A stored image reference does not verify that its file exists.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chapterId"],
      properties: {
        chapterId: identifierSchema,
        ...windowProperties,
        filter: {
          type: "string",
          enum: mcpReviewFilter.options,
          default: "all",
        },
        snapshot: { type: "string", pattern: "^[a-f0-9]{16}$" },
      },
    },
    invoke: async (args, context) => {
      allowArguments(args, [
        "chapterId",
        "offset",
        "limit",
        "filter",
        "snapshot",
      ]);
      const chapterId = readIdentifier(args.chapterId);
      const window = readWindow(args);
      const filter = mcpReviewFilter.safeParse(
        args.filter === undefined ? "all" : args.filter,
      );
      if (
        !filter.success ||
        (args.snapshot !== undefined &&
          (typeof args.snapshot !== "string" ||
            !/^[a-f0-9]{16}$/.test(args.snapshot))) ||
        (window.offset > 0 && args.snapshot === undefined)
      )
        throw new McpInvalidParams();
      context?.assertAuthorized();
      const result = await service.chapter(
        chapterId,
        window,
        filter.data,
        args.snapshot as string | undefined,
      );
      context?.assertAuthorized();
      return textContent(result);
    },
  };
}
function exportPreflightTool(service: McpReviewService): McpTool {
  return {
    name: "carrot_preflight_page_export",
    requiredScopes: ["carrot.read"],
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    description:
      "Check one saved page against the existing app's PNG export rules with translated text included. Returns public warning/info codes and counts, never paths or source text. Does not render/export, inspect live editor/jobs, check file/model/font readiness, authorize image transfer or reserve execution. No issues is NOT a guarantee of output success or translation quality. Use the returned revision for a later explicit export.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chapterId", "pageId"],
      properties: { chapterId: identifierSchema, pageId: identifierSchema },
    },
    invoke: async (args, context) => {
      allowArguments(args, ["chapterId", "pageId"]);
      const chapterId = readIdentifier(args.chapterId),
        pageId = readIdentifier(args.pageId);
      context?.assertAuthorized();
      const result = await service.preflight(chapterId, pageId);
      context?.assertAuthorized();
      return textContent(result);
    },
  };
}
