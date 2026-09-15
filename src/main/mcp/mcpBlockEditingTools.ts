import { z } from "zod/v4";
import {
  McpBlockPatchSchema,
  McpReadingOrderSchema,
} from "../../shared/mcpBlockEditing";
import type { McpPageEditService } from "../application/mcpPageEditService";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

/** New mutations require both existing edit and processing approvals. */
export function createMcpBlockEditingTools(
  service: McpPageEditService,
): McpTool[] {
  return [
    {
      name: "carrot_update_page_blocks",
      oauth: true,
      readOnly: false,
      destructive: true,
      idempotent: true,
      requiredScopes: ["carrot.read", "carrot.edit", "carrot.process"],
      description:
        "Patch explicit scalar fields and/or display geometry of existing blocks using the app's field editor. Read carrot_get_page_blocks first. renderRect is ORIGINAL IMAGE PIXELS; the app constrains display geometry and returns the actual normalized bbox. Source bbox, image layers, masks and untargeted blocks are preserved. Font-size edits follow the app's manual/auto-fit rules. No OCR, model call, erasure, render or implicit undo. Requires both edit and processing approval; stale or dirty pages fail. Generated lettering is retained, so check rendering after changing its fallback text/style.",
      inputSchema: z.toJSONSchema(McpBlockPatchSchema),
      invoke: async (args, context) => {
        const request = McpBlockPatchSchema.safeParse(args);
        if (!request.success) throw new McpInvalidParams();
        return textContent(
          await service.updateBlocks(request.data, context?.assertAuthorized),
        );
      },
    },
    {
      name: "carrot_set_page_reading_order",
      oauth: true,
      readOnly: false,
      destructive: true,
      idempotent: true,
      requiredScopes: ["carrot.read", "carrot.edit", "carrot.process"],
      description:
        "Set one page's reading order using every existing block ID exactly once. Read the current revision first. Does not reorder/delete block objects, change geometry/text, invoke models or alter images. Requires edit and processing approval. Identical effective order is a no-op.",
      inputSchema: z.toJSONSchema(McpReadingOrderSchema),
      invoke: async (args, context) => {
        const request = McpReadingOrderSchema.safeParse(args);
        if (!request.success) throw new McpInvalidParams();
        return textContent(
          await service.reorder(request.data, context?.assertAuthorized),
        );
      },
    },
  ];
}
