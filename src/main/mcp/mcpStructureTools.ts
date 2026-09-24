import { z } from "zod/v4";
import {
  McpStructurePreviewSchema,
  McpStructureGetSchema,
  McpStructureActionSchema,
  type McpStructureDirection,
} from "../../shared/mcpBlockStructure";
import { McpStructureService } from "../application/mcpStructureService";
import type { McpPageEditService } from "../application/mcpPageEditService";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

function identity(context: Parameters<McpTool["invoke"]>[1]) {
  if (!context?.principalId)
    throw new McpEditError(
      "access_denied",
      "An approved connection is required.",
    );
  context.assertAuthorized();
  return { owner: context.principalId, guard: context.assertAuthorized };
}
/** The calling AI infers exact targets from observations. No user pixel-entry UI. */
export function createMcpStructureTools(
  edits: McpPageEditService,
  lifetime?: AbortSignal,
): McpTool[] {
  const service = new McpStructureService(edits, Date.now, lifetime);
  const base = {
    oauth: true,
    idempotent: true,
    requiredScopes: ["carrot.read", "carrot.edit", "carrot.process"],
  };
  return [
    {
      ...base,
      name: "carrot_preview_block_structure_edit",
      readOnly: true,
      destructive: false,
      description:
        "Plan ONE same-page split (1 to 2), adjacent merge (2 to 1) or deletion. AI: inspect source, saved blocks and rendered page to interpret the user's intent; infer IDs, original-pixel rectangles, text allocation and style rather than asking the user for technical coordinates. Preserve wording by default. Does not save or run models. Preview contains before/after text, fields, ID mapping, order and warnings, never images. Ordinary blocks only; unsupported generated/automatic layouts are refused, never silently disabled. Then apply explicitly within the user's requested scope; repeated human approval is not required by this tool. Verify actual rendering afterwards. Session plans expire in 30 minutes.",
      inputSchema: z.toJSONSchema(McpStructurePreviewSchema),
      invoke: async (args, context) => {
        const { owner, guard } = identity(context);
        const parsed = McpStructurePreviewSchema.safeParse(args);
        if (!parsed.success) throw new McpInvalidParams();
        return textContent(await service.preview(owner, parsed.data, guard));
      },
    },
    {
      ...base,
      name: "carrot_get_block_structure_edit",
      readOnly: true,
      destructive: false,
      description:
        "Inspect this connection's structure plan/history, before/after data and current apply/undo/redo availability. Does not mutate, render or attach files. Availability is rechecked under the page lock on mutation. Use current revision; expired or conflicted history must not be forced.",
      inputSchema: z.toJSONSchema(McpStructureGetSchema),
      invoke: async (args, context) => {
        const { owner, guard } = identity(context);
        const parsed = McpStructureGetSchema.safeParse(args);
        if (!parsed.success) throw new McpInvalidParams();
        return textContent(
          await service.inspect(owner, parsed.data.editId, guard),
        );
      },
    },
    ...(["apply", "undo", "redo"] as const).map((direction) =>
      actionTool(service, direction),
    ),
  ];
}
function actionTool(
  service: McpStructureService,
  direction: McpStructureDirection,
): McpTool {
  return {
    name: `carrot_${direction}_block_structure_edit`,
    oauth: true,
    readOnly: false,
    destructive: true,
    idempotent: true,
    requiredScopes: ["carrot.read", "carrot.edit", "carrot.process"],
    description: `${direction.toUpperCase()} one owned structure edit through the app's page lease and atomic blocks/order save. Use its inspected revision and a NEW requestId per action. Exact retries return historical receipts without reapplying, even after the opposite action. Later page changes conflict; do not substitute a fresh revision to force old content. Images, masks and unrelated blocks are preserved; workflow completion can remain pending after restoration. No OCR, translation, model, erasure, output or attachments. After saving, re-read blocks and explicitly render the page to check the user's goal, then refine or undo if needed. Same-session 30-minute history only.`,
    inputSchema: z.toJSONSchema(McpStructureActionSchema),
    invoke: async (args, context) => {
      const { owner, guard } = identity(context);
      const parsed = McpStructureActionSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      return textContent(
        await service.act(owner, parsed.data, direction, guard),
      );
    },
  };
}
