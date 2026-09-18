import { McpImageEditPreviewSchema } from "../../shared/mcpImageEditing";
import {
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
} from "../../shared/mcpTranslationBatch";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import { createMcpImageEditPolicy } from "../application/mcpImageEditPolicy";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { productionInpaintingJobRuntime } from "../jobs/inpaintingJobRuntime";
import type { McpImageEditRuntime } from "./mcpImageEditExecution";
import type { McpImageHistory } from "./mcpImageEditPersistence";
import { createMcpImageEditAdapter } from "./mcpImageEditAdapter";
import { createMcpImageEditReadTools } from "./mcpImageEditReadTools";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { McpTool } from "./mcpReadTools";

type Editing = Parameters<typeof createMcpImageEditAdapter>[2];
const scopes = ["carrot.read", "carrot.edit", "carrot.process"];

export function createMcpImageEditSession(
  app: InpaintingJobContext,
  editing: Editing,
  enabled: boolean,
  allowImages: boolean,
  runtime: McpImageEditRuntime = productionInpaintingJobRuntime,
) {
  const lifetime = new AbortController();
  const history = app.inpaintingRevisionStore;
  if (
    !enabled ||
    !history?.inspectSinglePageTransaction ||
    !history.applySinglePageTransaction ||
    !history.releaseTransactions
  )
    return {
      tools: [] as McpTool[],
      stop: () => lifetime.abort(),
      close: async () => {
        lifetime.abort();
      },
    };
  const adapter = createMcpImageEditAdapter(
    app,
    history as McpImageHistory,
    editing,
    runtime,
    lifetime.signal,
  );
  const service = new McpPageBatchService(
    adapter.ports,
    createMcpImageEditPolicy(adapter.planning),
    Date.now,
    lifetime.signal,
  );
  return {
    tools: [
      ...imageEditTools(service),
      ...(allowImages
        ? createMcpImageEditReadTools((owner, args, guard) =>
            service.inspect(owner, args, guard),
          )
        : []),
    ],
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await service.close();
      await adapter.close();
    },
  };
}
type ImageService = McpPageBatchService<
  ReturnType<typeof McpImageEditPreviewSchema.parse>,
  Parameters<ReturnType<typeof createMcpImageEditPolicy>["project"]>[0],
  ReturnType<ReturnType<typeof createMcpImageEditPolicy>["request"]>,
  ReturnType<ReturnType<typeof createMcpImageEditPolicy>["project"]>
>;
function imageEditTools(service: ImageService): McpTool[] {
  const tools = [
    createMcpBatchTool({
      name: "carrot_preview_image_edit",
      schema: McpImageEditPreviewSchema,
      scopes,
      write: false,
      description:
        "Prepare one versioned page's image-only change: erase explicit block IDs (max 100), erase a freehand mask, paint an explicit color, or restore original pixels with native stroke/rectangle/ellipse geometry. Protected areas always win; block erasure also protects unselected source boxes and refuses excluded/generated blocks. Uses native mask calculation without OCR, translation, layout, models, downloads or saves. Max 16 million pixels, bounded geometry. Erasure requires an expected local engine and explicit approved asset-download permission when applied. Inspect the mask before explicit apply. Existing cleaned content, text, formatting and originals are retained. Session plan/history only; no uploaded files or arbitrary paths.",
      execute: (args, owner, guard) => service.preview(owner, args, guard),
    }),
    createMcpBatchTool({
      name: "carrot_get_image_edit",
      schema: McpTranslationBatchGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect an owned image-edit plan, exact effective/protected mask counts and native pixel-change outcomes. Poll until terminal after actions. A changed pixel/component is NOT proof that text was removed or visual quality is good. Availability is advisory: revision, context, files, ownership and native recovery are checked again on commit. A no-change result saves nothing; failures do not trigger another model call. Session plans expire after 30 idle minutes; native references are capped at 64 and released when this session closes.",
      execute: (args, owner, guard) => service.inspect(owner, args, guard),
    }),
  ];
  for (const direction of ["apply", "undo", "redo"] as const) {
    tools.push({
      ...createMcpBatchTool({
        name: `carrot_${direction}_image_edit`,
        schema: McpTranslationBatchActionSchema,
        scopes,
        write: true,
        background: true,
        description: `${direction.toUpperCase()} an owned reviewed image edit using a fresh requestId; exact retry receipts never reapply. Poll carrot_get_image_edit; cancel its active requestId explicitly. APPLY alone may run the selected local erasure engine; paint/restore and UNDO/REDO run no models. Native model cleanup finishes before publication. UNDO/REDO reuse retained native images/masks, never repeat inference, and refuse later user edits or changed artifacts. Apply/redo require unchanged work context. Original files, text, positions and formatting remain untouched. A failed notification may follow a successful save: inspect partial results before recovery. This is session-only recovery, not restart persistence.`,
        execute: async (args, owner, guard) =>
          service.start(owner, args, direction, guard),
      }),
      openWorld: direction === "apply",
    });
  }
  tools.push(
    createMcpBatchTool({
      name: "carrot_cancel_image_edit",
      schema: McpTranslationBatchActionSchema,
      scopes,
      write: true,
      description:
        "Cancel only the current image-edit action requestId shown by inspection. Wait for terminal status and native cleanup. No new save occurs after cancellation is observed, but a committed save is not rolled back automatically. Use explicit undo for saved changes. A stale cancellation ID cannot stop a newer action.",
      execute: async (args, owner, guard) => service.cancel(owner, args, guard),
    }),
  );
  return tools;
}
