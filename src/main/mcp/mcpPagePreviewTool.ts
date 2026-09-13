import type { McpPagePreviewService } from "../application/mcpPagePreviewService";
import {
  allowArguments,
  identifierSchema,
  readIdentifier,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

export function createMcpPagePreviewTool(
  service: McpPagePreviewService,
): McpTool {
  return {
    name: "carrot_get_page_preview",
    description:
      "Read a reduced PNG of a source page by chapterId and pageId. Only available when the local user enables image transfer. Existing redaction approval is required when enabled in the app. This does not translate the page.",
    inputSchema: {
      type: "object",
      properties: { chapterId: identifierSchema, pageId: identifierSchema },
      required: ["chapterId", "pageId"],
      additionalProperties: false,
    },
    invoke: async (args) => {
      allowArguments(args, ["chapterId", "pageId"]);
      const { imageData, ...metadata } = await service.getPreview(
        readIdentifier(args.chapterId),
        readIdentifier(args.pageId),
      );
      return [
        ...textContent(metadata),
        { type: "image", data: imageData, mimeType: "image/png" },
      ];
    },
  };
}
