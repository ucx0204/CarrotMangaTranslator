import { McpFormatBatchPreviewSchema } from "../../shared/mcpFormatBatch";
import {
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
} from "../../shared/mcpTranslationBatch";
import { formatBatchPolicy } from "../application/mcpFormatBatchPolicy";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { McpTool } from "./mcpReadTools";

type Ports = ReturnType<
  typeof import("./mcpTranslationBatchAdapter").createMcpFormatBatchPorts
>;
const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
export function createMcpFormatBatchTools(
  ports: Ports,
  lifetime?: AbortSignal,
): McpTool[] {
  const service = new McpPageBatchService(
    ports,
    formatBatchPolicy,
    Date.now,
    lifetime,
  );
  const tools = [
    createMcpBatchTool({
      name: "carrot_preview_format_batch",
      schema: McpFormatBatchPreviewSchema,
      description:
        "Plan explicit per-block FORMAT/display-rectangle changes across at most 50 pages/1000 blocks in ONE chapter. Infer targets from user feedback using search format conditions, blocks and rendering; users need not supply IDs or coordinates. Reuses the app field editor; returns actual normalized styles and side effects. Does not change source/translation text, source geometry, images, masks, review labels or reading order. No model, automatic font matching or writes. Manual font size/autofit edits are excluded by default; preserveManualFontSize=false only when the user's scope includes those changes. Generated lettering is always excluded. Inspect, explicitly apply and render each changed page. Fonts are not downloaded or verified. Session history expires after 30 minutes or restart.",
      scopes,
      write: false,
      execute: (args, owner, guard) => service.preview(owner, args, guard),
    }),
    createMcpBatchTool({
      name: "carrot_get_format_batch",
      schema: McpTranslationBatchGetSchema,
      description:
        "Inspect owned format plan/history, paginated stored/effective before-after styles, exclusion reasons, page outcomes and current conflicts. A receipt is not completion: poll every few seconds until terminal. No files, rendering or mutation. Effective values are app field-editor defaults, not final measured glyph sizes. After applying explicitly re-read blocks and render to evaluate the user's goal; refine or undo without forcing stale versions.",
      scopes: ["carrot.read"],
      write: false,
      execute: (args, owner, guard) => service.inspect(owner, args, guard),
    }),
  ];
  for (const direction of ["apply", "undo", "redo"] as const)
    tools.push(
      createMcpBatchTool({
        name: `carrot_${direction}_format_batch`,
        schema: McpTranslationBatchActionSchema,
        description: `${direction.toUpperCase()} an owned format batch with a NEW action UUID; exact retries return historical receipts without applying again. Poll carrot_get_format_batch until terminal. Fixed pages commit sequentially under app ownership; stop at the first conflict/failure/cancellation. Prior committed pages remain recorded. Undo/redo restore exact typography and display frames, including absent defaults and manual flags, only when no subsequent page edit conflicts. No whole-chapter atomicity, automatic merging, models, text changes, files or rendering. Verify rendered pages afterwards. Do not demand repeated user approval within already authorized scope.`,
        scopes,
        write: true,
        background: true,
        execute: async (args, owner, guard) =>
          service.start(owner, args, direction, guard),
      }),
    );
  tools.push(
    createMcpBatchTool({
      name: "carrot_cancel_format_batch",
      schema: McpTranslationBatchActionSchema,
      description:
        "Cancel only the active format action UUID returned by inspect. Wait for terminal state before undo. Stops future page commits, never rolls back already saved changes, never cancels a newer action using an old UUID. No models/files.",
      scopes,
      write: true,
      execute: async (args, owner, guard) => service.cancel(owner, args, guard),
    }),
  );
  return tools;
}
