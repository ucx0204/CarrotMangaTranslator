import { McpSoundEffectPrepareSchema } from "../../shared/mcpSoundEffects";
import {
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
} from "../../shared/mcpTranslationBatch";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import { createMcpSoundEffectPolicy } from "../application/mcpSoundEffectPolicy";
import { createMcpSoundEffectPorts } from "./mcpSoundEffectAdapter";
import { createMcpSoundEffectPreparation } from "./mcpSoundEffectPreparation";
import { createMcpSoundEffectReadTool } from "./mcpSoundEffectReadTool";
import { createMcpSoundEffectPrepareTools } from "./mcpSoundEffectPrepareTools";
import { createMcpSoundEffectImageTool } from "./mcpSoundEffectImageTool";
import { createMcpBatchTool } from "./mcpBatchTool";

export function createMcpSoundEffectSession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  editing: Parameters<typeof createMcpSoundEffectPorts>[1],
  enabled: boolean,
  allowImages: boolean,
  runtime?: Parameters<typeof createMcpSoundEffectPreparation>[1],
) {
  const lifetime = new AbortController();
  const batches = new McpPageBatchService(
    createMcpSoundEffectPorts(app, editing, lifetime.signal),
    createMcpSoundEffectPolicy(
      createMcpSoundEffectPreparation(app.appPaths, runtime),
    ),
    Date.now,
    lifetime.signal,
  );
  const preparation = createMcpSoundEffectPrepareTools(
    app,
    operations,
    async (owner, input, context) => {
      const receipt = await batches.preview(
        owner,
        input,
        context.assertAuthorized,
        context.signal,
      );
      const plan = batches.readOwnedPlan(
        owner,
        receipt.batchId,
        context.assertAuthorized,
      );
      return {
        batchId: receipt.batchId,
        expiresAt: receipt.expiresAt,
        generationCalls: plan.generationCalls,
        failedItems: plan.failedItems,
      };
    },
    lifetime.signal,
  );
  return {
    tools: [
      createMcpSoundEffectReadTool(app.appPaths),
      ...(enabled
        ? [
            ...preparation.tools.filter(
              (tool) =>
                allowImages || tool.name !== "carrot_generate_sound_effects",
            ),
            ...actionTools(batches),
            ...(allowImages
              ? [
                  createMcpSoundEffectImageTool(
                    async (owner, batchId, guard) => {
                      const view = await batches.inspect(
                        owner,
                        { batchId, limit: 1 },
                        guard,
                      );
                      return {
                        chapterId: view.chapterId,
                        plan: batches.readOwnedPlan(owner, batchId, guard),
                      };
                    },
                    lifetime.signal,
                  ),
                ]
              : []),
          ]
        : []),
    ],
    stop: () => lifetime.abort(),
    close: async () => {
      lifetime.abort();
      await preparation.close();
      await batches.close();
    },
  };
}
type Batches = McpPageBatchService<
  ReturnType<typeof McpSoundEffectPrepareSchema.parse>,
  Parameters<ReturnType<typeof createMcpSoundEffectPolicy>["project"]>[0],
  ReturnType<ReturnType<typeof createMcpSoundEffectPolicy>["request"]>,
  ReturnType<ReturnType<typeof createMcpSoundEffectPolicy>["project"]>,
  Awaited<ReturnType<ReturnType<typeof createMcpSoundEffectPolicy>["plan"]>>
>;
function actionTools(batches: Batches) {
  const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
  const tools = [
    createMcpBatchTool({
      name: "carrot_get_sound_effect_batch",
      schema: McpTranslationBatchGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect the owned live sound-effect plan and its before/after candidate/text/image metadata, skipped or failed items and applied-page results. No image bytes, paths or model reruns. Availability is advisory; actual writes recheck original/cleaned/mask hashes, page/review/context snapshots. Plan has a 30-minute idle lifetime; session shutdown removes recovery. A successful generation is not a saved change or proof of visual text quality.",
      execute: (args, owner, guard) => batches.inspect(owner, args, guard),
    }),
  ];
  for (const direction of ["apply", "undo", "redo"] as const)
    tools.push(
      createMcpBatchTool({
        name: `carrot_${direction}_sound_effect_batch`,
        schema: McpTranslationBatchActionSchema,
        scopes,
        write: true,
        background: true,
        description: `${direction.toUpperCase()} the reviewed owned single-page sound-effect change with a new action requestId. Existing native page/context ownership and atomic library transaction; never submit raw snapshots or rerun generation, OCR, translation, erasure or layout. Source and review conflicts fail closed. Exact undo restores optional fields, blocks, reading order and candidate ledger without overwriting later user edits. Undo tolerates changed context; redo still rechecks it. Acknowledged save survives notification failure; retrying an old action does not repeat it. Poll get_sound_effect_batch. Session recovery only.`,
        execute: async (args, owner, guard) =>
          batches.start(owner, args, direction, guard),
      }),
    );
  tools.push(
    createMcpBatchTool({
      name: "carrot_cancel_sound_effect_batch",
      schema: McpTranslationBatchActionSchema,
      scopes,
      write: true,
      description:
        "Cancel only the current sound-effect apply/undo/redo requestId. Already saved changes remain and need explicit undo; old cancellation cannot stop a later action. Wait for terminal status. To stop preparation/image generation use cancel_job, not this tool.",
      execute: async (args, owner, guard) => batches.cancel(owner, args, guard),
    }),
  );
  return tools;
}
