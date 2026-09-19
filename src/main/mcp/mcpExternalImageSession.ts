import { McpExternalImagePreviewSchema } from "../../shared/mcpExternalImages";
import { McpTranslationBatchGetSchema, McpTranslationBatchActionSchema } from "../../shared/mcpTranslationBatch";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import { createMcpExternalImagePolicy } from "../application/mcpExternalImagePolicy";
import { createMcpExternalImageAdapter } from "./mcpExternalImageAdapter";
import { createMcpExternalImageReadTool } from "./mcpExternalImageReadTool";
import { createMcpImageUploadSession } from "./mcpImageUploadSession";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { McpTool } from "./mcpReadTools";

export function createMcpExternalImageSession(app: InpaintingJobContext,
  editing: Parameters<typeof createMcpExternalImageAdapter>[1], enabled: boolean, allowImages: boolean,
) {
  const lifetime = new AbortController();
  const uploads = createMcpImageUploadSession(lifetime.signal);
  const adapter = createMcpExternalImageAdapter(app, editing, uploads.store, lifetime.signal);
  const service = new McpPageBatchService(adapter.ports, createMcpExternalImagePolicy(adapter.planning), Date.now, lifetime.signal);
  const stop = () => { lifetime.abort(); uploads.stop(); };
  return {
    tools: enabled ? [ ...uploads.tools, ...externalTools(service),
      ...(allowImages ? [createMcpExternalImageReadTool(uploads.store, (owner, args, guard) => service.inspect(owner, args, guard), lifetime.signal)] : []),
    ] : [] as McpTool[],
    stop,
    close: async () => {
      stop();
      await service.close();
      await uploads.close();
    },
  };
}
type Service = McpPageBatchService<
  ReturnType<typeof McpExternalImagePreviewSchema.parse>,
  Parameters<ReturnType<typeof createMcpExternalImagePolicy>["project"]>[0],
  ReturnType<ReturnType<typeof createMcpExternalImagePolicy>["request"]>,
  ReturnType<ReturnType<typeof createMcpExternalImagePolicy>["project"]>,
  Awaited<ReturnType<ReturnType<typeof createMcpExternalImagePolicy>["plan"]>>
>;
function externalTools(service: Service): McpTool[] {
  const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
  const tools = [
    createMcpBatchTool({
      name: "carrot_preview_external_image", schema: McpExternalImagePreviewSchema, scopes, write: false,
      description: "Review validated owned PNG uploads bound to one current saved page/context. LETTERING may be applied to one existing block via native generatedLettering (2 MiB normalized PNG and existing bounded history); preserves source/translation/geometry and native decorations unless explicitly cleared. Existing layers require replaceExisting=true. Binary masks select and protected masks subtract. BACKGROUND replacement/patch candidates are preview-only in this checkpoint: canApply=false; native background publication is not connected. Patch dimensions exactly match rect, selected background pixels must be opaque. No automatic resizing, erasure, OCR, translation, model, settings change or save.",
      execute: (args, owner, guard) => service.preview(owner, args, guard),
    }),
    createMcpBatchTool({
      name: "carrot_get_external_image", schema: McpTranslationBatchGetSchema, scopes: ["carrot.read"], write: false,
      description: "Inspect an owned external image plan, exclusions, exact selected/protected pixel counts and asynchronous action results without images or file paths. Background candidates explicitly exclude application. Poll until terminal; changes are not model-quality claims. Session history only, 30-minute idle expiry.",
      execute: (args, owner, guard) => service.inspect(owner, args, guard),
    }),
  ];
  for (const direction of ["apply", "undo", "redo"] as const) tools.push(createMcpBatchTool({
    name: `carrot_${direction}_external_image`, schema: McpTranslationBatchActionSchema, scopes,
    write: true, background: true,
    description: `${direction.toUpperCase()} only the owned reviewed LETTERING layer with a new action requestId. No models or background-image publication. Apply checks upload content/readiness/expiry and current page/source/context again under native ownership. Undo/redo use retained exact block snapshots, not another upload or inference; later edits conflict. Prior action IDs never reapply. Native save is recorded before UI notification. Poll carrot_get_external_image; cancellation is not rollback. History is session-only and bounded.`,
    execute: async (args, owner, guard) => service.start(owner, args, direction, guard),
  }));
  tools.push(createMcpBatchTool({
    name: "carrot_cancel_external_image", schema: McpTranslationBatchActionSchema, scopes, write: true,
    description: "Cancel only the active external lettering action requestId. Wait for terminal status. A previously committed change remains saved and requires explicit undo; an old cancellation cannot stop a later action.",
    execute: async (args, owner, guard) => service.cancel(owner, args, guard),
  }));
  return tools;
}
