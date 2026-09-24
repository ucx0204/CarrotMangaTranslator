import { McpTypographyBatchPreviewSchema } from "../../shared/mcpTypographyBatch";
import {
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
} from "../../shared/mcpTranslationBatch";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import { createMcpTypographyBatchPolicy } from "../application/mcpTypographyBatchPolicy";
import { McpPageEditService } from "../application/mcpPageEditService";
import type { McpOperationService } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { openChapter, savePageBlocks } from "../library";
import { createMcpBatchTool } from "./mcpBatchTool";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpTypographyBatchAdapter } from "./mcpTypographyBatchAdapter";

const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};

export function createMcpTypographyBatchSession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  editing: Editing,
  enabled: boolean,
) {
  const lifetime = new AbortController();
  const service = createService(app, operations, editing, lifetime.signal);
  return {
    waitForAction: service.waitForAction.bind(service),
    tools: enabled ? typographyTools(service) : [],
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await service.close();
    },
  };
}

function createService(
  app: InpaintingJobContext,
  operations: McpOperationService,
  editing: Editing,
  lifetime: AbortSignal,
) {
  const edits = new McpPageEditService({
    openChapter,
    savePageBlocks,
    ...editing,
    withPageEdit: createMcpPageEditScope(app, openChapter, lifetime),
  });
  const adapter = createMcpTypographyBatchAdapter(edits, operations);
  return new McpPageBatchService(
    adapter.ports,
    createMcpTypographyBatchPolicy(adapter.planning),
    Date.now,
    lifetime,
  );
}

function typographyTools(service: ReturnType<typeof createService>) {
  const tools = [
    createMcpBatchTool({
      name: "carrot_preview_typography_batch",
      schema: McpTypographyBatchPreviewSchema,
      description:
        "Plan font-only, source-size-only or combined changes to explicit observed blocks in ONE chapter. First complete carrot_run_typography_analysis and use its owned analysisJobId plus current page/context revisions. No supplied font guesses, raw observations or whole-block objects. Rechecks original image hashes, catalog and work font profile; preserves manual font locks and protects manual sizes by default. Measured face pixels are not nominal fontSizePx. No OCR, models, downloads, text/geometry/image changes or saves. Inspect before explicit application. Analysis and session history expire after 30 minutes or restart.",
      scopes,
      write: false,
      execute: (args, owner, guard) => service.preview(owner, args, guard),
    }),
    createMcpBatchTool({
      name: "carrot_get_typography_batch",
      schema: McpTranslationBatchGetSchema,
      description:
        "Inspect an owned typography plan and paginated before/after scalar states, exclusions and per-page outcomes. Poll until terminal after an action. Availability is advisory: source-file, catalog, profile and dependency checks run again under ownership before forward commits. No model, files, rendering or mutation. History is session-only; observe final rendering separately after all requested implementation work is ready.",
      scopes: ["carrot.read"],
      write: false,
      execute: (args, owner, guard) => service.inspect(owner, args, guard),
    }),
  ];
  for (const direction of ["apply", "undo", "redo"] as const)
    tools.push(
      createMcpBatchTool({
        name: `carrot_${direction}_typography_batch`,
        schema: McpTranslationBatchActionSchema,
        description: `${direction.toUpperCase()} an owned typography plan using a fresh action UUID; identical retries return historical receipts. Poll carrot_get_typography_batch. Sequential native page commits stop at the first conflict, failure or cancellation; prior saves stay recorded. Apply/redo require fresh original hashes, catalog/profile, full analysis dependencies and unexpired evidence. Undo restores exact stored state including absent fields and does not need expired analysis or removed fonts, but never overwrites subsequent page edits. No automatic rerun, OCR, model, download, translation, geometry, masks, files or rendering. Approval stays within the user's authorized scope.`,
        scopes,
        write: true,
        background: true,
        execute: async (args, owner, guard) =>
          service.start(owner, args, direction, guard),
      }),
    );
  tools.push(
    createMcpBatchTool({
      name: "carrot_cancel_typography_batch",
      schema: McpTranslationBatchActionSchema,
      description:
        "Cancel only the active typography action UUID returned by inspect. Stops future commits; already saved pages remain and need explicit undo. An older action cannot cancel a newer one. Wait for terminal state before recovery. No models or files.",
      scopes,
      write: true,
      execute: async (args, owner, guard) => service.cancel(owner, args, guard),
    }),
  );
  return tools;
}
