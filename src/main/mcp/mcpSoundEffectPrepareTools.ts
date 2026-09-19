import { z } from "zod/v4";
import { McpSoundEffectPrepareSchema, type McpSoundEffectPrepare } from "../../shared/mcpSoundEffects";
import type { McpOperationContext, McpOperationService } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { readWorkContextForEdit, openChapter } from "../library";
import { retainLibrarySnapshot, withLibraryRead } from "../library/lock";
import { assertContextTarget } from "../application/mcpContextEditPolicy";
import { createMcpBatchTool } from "./mcpBatchTool";
import { runMcpAppJob } from "./mcpAppJob";

type PlanReference = { batchId: string; expiresAt: number; generationCalls: number; failedItems: number };
type Prepare = (owner: string, input: McpSoundEffectPrepare, context: McpOperationContext) => Promise<PlanReference>;
const commands = McpSoundEffectPrepareSchema.shape.command.options;
const editSchema = McpSoundEffectPrepareSchema.extend({ command: z.discriminatedUnion("kind", [commands[0], commands[1], commands[2], commands[3]]) });
const generationSchema = McpSoundEffectPrepareSchema.extend({ command: commands[4] });

export function createMcpSoundEffectPrepareTools(app: InpaintingJobContext, operations: McpOperationService,
  prepare: Prepare, lifetime: AbortSignal) {
  const pending = new Set<Promise<unknown>>();
  const tools = [false, true].map(generation => ({
    ...createMcpBatchTool({
      name: generation ? "carrot_generate_sound_effects" : "carrot_prepare_sound_effect_batch",
      schema: generation ? generationSchema : editSchema,
      scopes: ["carrot.read", "carrot.edit", "carrot.process", ...(generation ? ["carrot.images"] : [])],
      write: false, background: true,
      description: generation
        ? "Generate foreground image assets for at most 10 explicitly selected SAVED sound-effect blocks through the configured supported Codex image controller and existing app lettering engine. Requires allowExternalProcessing=true and exact expectedModel; uses account quota and may incur provider cost. Existing layers require replaceExisting=true. Refusals never trigger a fallback provider or automatic retry. Native render-box adjustment requires allowRenderAdjustment=true. Returns job ID: inspect result.soundEffectPlan, then get_sound_effect_batch and separately apply. Sequential targets, no OCR, translation, erasure, region replanning, C23, rendering, page save or model downloads. External artwork instead uses validated upload tools. Cancel generation using cancel_job."
        : "Prepare ONE saved page of explicit sound-effect candidate include/exclude/restore decisions, manual regions, approved candidate text materialization, saved sound-text edits, or image enable/disable/remove. Unspecified candidates and dialogue remain unchanged. Rectangles are ORIGINAL pixels. Preserve detector records; overlapping materialization requires allowOverlap. No OCR or translation is performed for supplied text. Stale image text is never silently regenerated and blocked images cannot be enabled. No models, external calls, erasure or page saves. Returns a job ID; inspect result.soundEffectPlan then get_sound_effect_batch; application and exact recovery are separate.",
      execute: async (value, owner, guard) => {
        const input = McpSoundEffectPrepareSchema.parse(value);
        return operations.start({ owner, kind: "soundEffectPrepare", requestId: input.requestId,
          parameters: input, assertAuthorized: guard,
          execute: context => {
            const task = runPreparation(app, owner, input, context, prepare, lifetime);
            pending.add(task);
            return task.finally(() => pending.delete(task));
          },
        });
      },
    }),
    readOnly: false, destructive: false, openWorld: generation,
  }));
  return { tools, close: async () => { await Promise.allSettled([...pending]); } };
}

async function runPreparation(app: InpaintingJobContext, owner: string, input: McpSoundEffectPrepare,
  operation: McpOperationContext, prepare: Prepare, lifetime: AbortSignal) {
  const signal = AbortSignal.any([operation.signal, lifetime]);
  const context = { ...operation, signal, assertAuthorized: () => { signal.throwIfAborted(); operation.assertAuthorized(); } };
  return runMcpAppJob(app, context, "gemma-analysis", async current => {
    const saved = await readWorkContextForEdit(input.chapterId);
    const release = await withLibraryRead(async () => retainLibrarySnapshot([
      { kind: "work-context", scope: saved.workId, access: "read" },
    ], []));
    try {
      current.assertAuthorized();
      assertContextTarget(await readWorkContextForEdit(input.chapterId), input.chapterId, input.contextRevision);
      current.progress({ phase: input.command.kind === "generate" ? "sound_effect_generation" : "sound_effect_preparation" });
      const plan = await prepare(owner, input, current);
      current.assertAuthorized();
      return { kind: "sound-effect-plan", status: plan.failedItems ? "partial" : "prepared", chapterId: input.chapterId,
        pageId: input.pageId, pagesChanged: 0, needsReview: true,
        performed: [input.command.kind === "generate" ? "sound_effect_generation" : "sound_effect_preparation"],
        soundEffectPlan: plan };
    } finally { release(); }
  }, { resources: input.command.kind === "generate" ? [{ kind: "model-runtime", scope: "*", access: "write" }] : [],
    page: { chapterId: input.chapterId, pageId: input.pageId, readChapter: openChapter } });
}
