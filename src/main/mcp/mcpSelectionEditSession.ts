import { McpSelectionBatchPreviewSchema } from "../../shared/mcpSelectionEditing";
import {
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
} from "../../shared/mcpTranslationBatch";
import type { McpOperationService } from "../application/mcpOperationService";
import type { McpSelectionAnalysisService } from "../application/mcpSelectionAnalysisService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import { createMcpSelectionEditPolicy } from "../application/mcpSelectionEditPolicy";
import { McpPageEditService } from "../application/mcpPageEditService";
import { openChapter, savePageBlocks } from "../library";
import { inspectStoredPublicSettings } from "../settingsPublicSnapshot";
import { normalizeBlockFormatDefaults } from "../settings/blockFormatDefaultsNormalize";
import { asRecord } from "../settings/appSettingsResolvers";
import { createMcpBatchTool } from "./mcpBatchTool";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpSelectionEditAdapter } from "./mcpSelectionEditAdapter";

type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
const scopes = ["carrot.read", "carrot.edit", "carrot.process"];

export function createMcpSelectionEditSession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  analyses: McpSelectionAnalysisService,
  editing: Editing,
) {
  const lifetime = new AbortController();
  const edits = new McpPageEditService({
    openChapter,
    savePageBlocks,
    ...editing,
    withPageEdit: createMcpPageEditScope(app, openChapter, lifetime.signal),
  });
  const adapter = createMcpSelectionEditAdapter(
    edits,
    operations,
    analyses,
    () =>
      inspectStoredPublicSettings(app.appPaths, (record) =>
        normalizeBlockFormatDefaults(asRecord(record.blockFormatDefaults), {}),
      ),
  );
  const service = new McpPageBatchService(
    adapter.ports,
    createMcpSelectionEditPolicy(adapter.planning),
    Date.now,
    lifetime.signal,
  );
  return {
    tools: selectionEditTools(service),
    waitForAction: service.waitForAction.bind(service),
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await service.close();
    },
  };
}

function selectionEditTools(
  service: McpPageBatchService<
    ReturnType<typeof McpSelectionBatchPreviewSchema.parse>,
    Parameters<ReturnType<typeof createMcpSelectionEditPolicy>["project"]>[0],
    ReturnType<ReturnType<typeof createMcpSelectionEditPolicy>["request"]>,
    ReturnType<ReturnType<typeof createMcpSelectionEditPolicy>["project"]>,
    Awaited<ReturnType<ReturnType<typeof createMcpSelectionEditPolicy>["plan"]>>
  >,
) {
  const tools = [
    createMcpBatchTool({
      name: "carrot_preview_selection_batch",
      schema: McpSelectionBatchPreviewSchema,
      scopes,
      write: false,
      description:
        "Plan explicit source/translation edits from an owned completed selection analysis, reviewed region-discovery appends, OR character/glossary reference edits. One chapter, at most 20 pages and 100 changes. Read page/context revisions first. Analysis commands accept item IDs, not supplied model text or raw blocks. Empty observations never clear existing text. Generated lettering is excluded. Append requires exact discovery sequence, explicit overlap approval when reported, and optional existing afterBlockId (null means first; omitted means append). Native block defaults/coordinates/order are reused. References use enabled native work IDs; omitted fields preserve, null removes the field, [] stores an empty glossary list. No model, OCR, translation, erasure, rendering, file output or page save occurs. Inspect before applying within the authorized scope.",
      execute: (args, owner, guard) => service.preview(owner, args, guard),
    }),
    createMcpBatchTool({
      name: "carrot_get_selection_batch",
      schema: McpTranslationBatchGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect an owned selection edit plan with bounded before/after text and reference fields, created block IDs, original-pixel rectangles, overlap IDs, exclusions and page outcomes. Poll until terminal after actions. Availability is advisory; all selected/dependent pages, original hashes and context are rechecked at forward commit. No images, raw blocks, paths, files, models or mutation. Session history has 30-minute idle expiry and is not restored after restart.",
      execute: (args, owner, guard) => service.inspect(owner, args, guard),
    }),
  ];
  for (const direction of ["apply", "undo", "redo"] as const) {
    tools.push(
      createMcpBatchTool({
        name: `carrot_${direction}_selection_batch`,
        schema: McpTranslationBatchActionSchema,
        scopes,
        write: true,
        background: true,
        description: `${direction.toUpperCase()} an owned reviewed selection plan with a fresh action requestId. Exact retries return historical receipts without reapplying. Poll carrot_get_selection_batch. Native page commits run sequentially and stop on conflict/failure/cancellation, preserving recorded earlier saves. Apply/redo recheck every analysis dependency, original hash, context and fixed evidence expiry. Undo restores exact selected blocks and optional reference fields and removes only the owned appended blocks, including the original reading-order absence; no expired model observation is needed. Later user edits conflict. No model rerun, implicit OCR/erasure/formatting, files or rendering. Cancel never automatically rolls back saved pages.`,
        execute: async (args, owner, guard) =>
          service.start(owner, args, direction, guard),
      }),
    );
  }
  tools.push(
    createMcpBatchTool({
      name: "carrot_cancel_selection_batch",
      schema: McpTranslationBatchActionSchema,
      scopes,
      write: true,
      description:
        "Cancel only the current selection action requestId shown by inspection. Wait for terminal status before undo or another action. Earlier cancellations cannot cancel a newer action. Already committed pages remain saved and require explicit undo. No model, file or rendering.",
      execute: async (args, owner, guard) => service.cancel(owner, args, guard),
    }),
  );
  return tools;
}
