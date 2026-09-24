import { createMcpLetteringResourceTools } from "./mcpLetteringResourceTools";
import {
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
} from "../../shared/mcpTranslationBatch";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import { McpPageEditService } from "../application/mcpPageEditService";
import { createMcpLetteringPolicy } from "../application/mcpLetteringPolicy";
import type { McpOperationService } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { openChapter, savePageBlocks } from "../library";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpLetteringAdapter } from "./mcpLetteringAdapter";
import { createMcpBatchTool } from "./mcpBatchTool";
import { createMcpLetteringPrepareTool } from "./mcpLetteringPrepareTool";

const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
export function createMcpLetteringSession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  editing: Editing,
  enabled: boolean,
  runtime?: Parameters<typeof createMcpLetteringAdapter>[2],
) {
  const lifetime = new AbortController();
  const { batches, resources } = createService(
    app,
    editing,
    lifetime.signal,
    runtime,
  );
  return {
    waitForAction: batches.waitForAction.bind(batches),
    tools: [
      ...createMcpLetteringResourceTools(resources),
      ...(enabled
        ? [
            createMcpLetteringPrepareTool(
              app,
              operations,
              (owner, input, context) =>
                batches.preview(
                  owner,
                  input,
                  context.assertAuthorized,
                  context.signal,
                ),
              lifetime.signal,
            ),
            ...letteringTools(batches),
          ]
        : []),
    ],
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await batches.close();
    },
  };
}
function createService(
  app: InpaintingJobContext,
  editing: Editing,
  lifetime: AbortSignal,
  runtime?: Parameters<typeof createMcpLetteringAdapter>[2],
) {
  const edits = new McpPageEditService({
    ...editing,
    openChapter,
    savePageBlocks,
    withPageEdit: createMcpPageEditScope(app, openChapter, lifetime),
  });
  const adapter = createMcpLetteringAdapter(app, edits, runtime);
  const batches = new McpPageBatchService(
    adapter.ports,
    createMcpLetteringPolicy(adapter.prepare),
    Date.now,
    lifetime,
  );
  return { batches, resources: adapter.resources };
}
type Batches = ReturnType<typeof createService>["batches"];
function letteringTools(batches: Batches) {
  const tools = [
    createMcpBatchTool({
      name: "carrot_get_lettering_batch",
      schema: McpTranslationBatchGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect an owned prepared lettering plan: paginated before/after text, styles, transforms and summarized bubble geometry, exclusions and per-page results. No models, rendering or writes. Poll after actions. Availability is advisory; original/cleaned-image and font-catalog checks repeat under native page ownership. Session-only 30-minute idle history.",
      execute: (args, owner, guard) => batches.inspect(owner, args, guard),
    }),
  ];
  for (const direction of ["apply", "undo", "redo"] as const)
    tools.push(
      createMcpBatchTool({
        name: `carrot_${direction}_lettering_batch`,
        schema: McpTranslationBatchActionSchema,
        scopes,
        write: true,
        background: true,
        description: `${direction} an owned lettering plan with a new action requestId. Poll carrot_get_lettering_batch. Existing native transactions run sequentially and stop on the first failure/conflict/cancellation; committed pages remain explicit. Forward saves recheck every selected page revision, chapter membership and context. Geometry also rechecks selected source/cleaned-image dependencies; styling rechecks the font catalog. Saved-resource plans additionally recheck their resource and enabled sequence definitions. Undo restores exact optional state without requiring models, old images or installed fonts; it cannot overwrite later user edits. No OCR, translation, erasure, rendering or downloads.`,
        execute: async (args, owner, guard) =>
          batches.start(owner, args, direction, guard),
      }),
    );
  tools.push(
    createMcpBatchTool({
      name: "carrot_cancel_lettering_batch",
      schema: McpTranslationBatchActionSchema,
      scopes,
      write: true,
      description:
        "Cancel the currently active lettering apply/undo/redo actionId only. Cancellation stops future page commits, not previous saves. To cancel preparation use carrot_cancel_job. Wait for terminal status before undo.",
      execute: async (args, owner, guard) => batches.cancel(owner, args, guard),
    }),
  );
  return tools;
}
