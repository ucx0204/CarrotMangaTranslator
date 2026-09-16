import { z } from "zod/v4";
import {
  McpBlockPatchSchema,
  McpReadingOrderSchema,
} from "../../shared/mcpBlockEditing";
import { McpSourceRectPatchSchema } from "../../shared/mcpSourceRect";
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
    {
      name: "carrot_update_block_source_rect",
      oauth: true,
      readOnly: false,
      destructive: true,
      idempotent: true,
      requiredScopes: ["carrot.read", "carrot.edit", "carrot.process"],
      description:
        "Change ONLY one existing block's source OCR/erasure rectangle in ORIGINAL IMAGE PIXELS; fractional pixels are accepted. Read carrot_get_page_blocks first. Requires the current revision even for a no-op: after a lost response or conflict, re-read before retrying. Rejects off-page or unrepresentable bounds rather than clipping them. Preserves text, stored typography, explicit display geometry, other blocks, images and masks. A legacy implicit display frame is pinned before changing source geometry. Actual changes to generated bubble layouts with source-font measurements or source-matched font intent are rejected to avoid changing typography; do not disable those settings automatically. Retained source evidence may need review; warnings never run processing. Does not run OCR, models, erasure, rendering, export or implicit undo. Requires edit and processing approval; no image transfer or attachments.",
      inputSchema: z.toJSONSchema(McpSourceRectPatchSchema),
      invoke: async (args, context) => {
        const request = McpSourceRectPatchSchema.safeParse(args);
        if (!request.success) throw new McpInvalidParams();
        return textContent(
          await service.updateSourceRect(
            request.data,
            context?.assertAuthorized,
          ),
        );
      },
    },
  ];
}
