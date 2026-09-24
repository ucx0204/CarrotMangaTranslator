import { z } from "zod/v4";
import { mcpTranslationBatchOutputs } from "../../shared/mcpTranslationBatch";
import { captureSoundEffectPage } from "../../shared/soundEffectPageSnapshot";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { SoundEffectPlan } from "../application/mcpSoundEffectPolicy";
import type { McpCompositeGuard } from "../application/mcpCompositeWorkflowPorts";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import { mcpBatchMembership } from "../application/mcpPageBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpTool } from "./mcpReadTools";
import type { McpCompositeNativePage } from "./mcpCompositeNativePages";
import { invokeMcpCompositeNativeTool } from "./mcpCompositeNativeTools";
import {
  assertCompositeBlocks,
  nativeCompositeCost,
  scopeError,
  selectCompositeNativePages,
} from "./mcpCompositeNativeScope";

const readers = {
  "selection-apply": "carrot_get_selection_batch",
  "typography-apply": "carrot_get_typography_batch",
  "lettering-apply": "carrot_get_lettering_batch",
  "sfx-apply": "carrot_get_sound_effect_batch",
} as const;
export type CompositeBatchFamily = keyof typeof readers;
const change = z.object({
  pageId: z.string(),
  blockId: z.string().optional(),
  id: z.string().optional(),
  changed: z.boolean(),
  excludedReason: z.string().nullable(),
});
const summarySchema =
  mcpTranslationBatchOutputs.carrot_preview_translation_batch.strip();
const inspectionSchema = summarySchema.extend({
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  limit: z.number().int().min(1).max(25),
  changes: z.array(change).max(100),
});
type ReadOptions = {
  tools: readonly McpTool[];
  readSoundEffectPlan: (
    owner: string,
    id: string,
    guard: () => void,
  ) => SoundEffectPlan;
};

/** Bounded native inspection pagination, never status polling or execution. */
export async function readCompositeNativeBatch(
  options: ReadOptions,
  owner: string,
  family: CompositeBatchFamily,
  batchId: string,
  guard: McpCompositeGuard,
) {
  const changes: z.infer<typeof change>[] = [];
  let offset = 0;
  let summary: z.infer<typeof summarySchema> | undefined;
  while (changes.length <= 5000) {
    const result = await invokeMcpCompositeNativeTool(
      options.tools,
      readers[family],
      { batchId, offset, limit: 25 },
      owner,
      guard,
    );
    const view = inspectionSchema.parse(result.structuredContent);
    const current = summarySchema.parse(view);
    assertBatchInspection(view, batchId, offset, summary);
    summary = current;
    changes.push(...view.changes);
    if (view.nextOffset === null) break;
    if (
      !view.changes.length ||
      view.nextOffset !== offset + view.changes.length
    )
      throw scopeError();
    offset = view.nextOffset;
  }
  if (!summary || changes.length !== summary.totalChanges) throw scopeError();
  const soundPlan =
    family === "sfx-apply"
      ? options.readSoundEffectPlan(owner, batchId, guard)
      : undefined;
  guard();
  return { summary, changes, soundPlan };
}
export function costCompositeNativeBatch(
  values: McpCompositeNativePage[],
  batch: Awaited<ReturnType<typeof readCompositeNativeBatch>>,
  requestId: string,
) {
  const { summary, changes, soundPlan } = batch;
  const replay =
    summary.activeRequestId === requestId &&
    summary.direction === "apply" &&
    summary.status === "completed";
  if (!summary.canApply && !replay)
    throw new McpEditError(
      "invalid_edit",
      "The owned native batch is not available for this exact apply action.",
    );
  const pages = selectCompositeNativePages(
    values,
    summary.chapterId,
    summary.pages.map((page) => ({
      pageId: page.pageId,
      revision: page.expectedRevision,
    })),
    summary.contextRevision,
  );
  const cost = nativeCompositeCost(pages.length);
  for (const value of pages) {
    const selected = changes.filter(
      (item) =>
        item.pageId === value.page.id && item.changed && !item.excludedReason,
    );
    if (soundPlan) assertSoundEffectScope(value, soundPlan, replay);
    else
      assertCompositeBlocks(
        value,
        [
          ...new Set(
            selected.map((item) => {
              if (!item.blockId) throw scopeError();
              return item.blockId;
            }),
          ),
        ],
        true,
      );
    const count = Math.max(
      selected.length,
      summary.pages.find((page) => page.pageId === value.page.id)
        ?.changedBlocks ?? 0,
    );
    if (count > 100) throw scopeError();
    cost.pageEdits.push({
      chapterId: summary.chapterId,
      pageId: value.page.id,
      edits: count,
    });
    cost.selectedEdits += count;
  }
  if (
    changes.some(
      (item) => !pages.some((value) => value.page.id === item.pageId),
    )
  )
    throw scopeError();
  return cost;
}
export function assertSoundEffectScope(
  value: McpCompositeNativePage,
  plan: SoundEffectPlan,
  completed: boolean,
) {
  if (
    plan.workId !== value.target.workId ||
    plan.membership !== mcpBatchMembership(value.saved.chapter) ||
    hashStableValue(captureSoundEffectPage(value.page)) !==
      hashStableValue(completed ? plan.after : plan.before)
  )
    throw scopeError();
  if (!value.target.blockIds.length) return;
  const { blocks: before, ...beforePage } = plan.before;
  const { blocks: after, ...afterPage } = plan.after;
  if (hashStableValue(beforePage) !== hashStableValue(afterPage))
    throw scopeError();
  const allowed = new Set(value.target.blockIds);
  if (
    hashStableValue(before.filter((block) => !allowed.has(block.id))) !==
    hashStableValue(after.filter((block) => !allowed.has(block.id)))
  )
    throw scopeError();
  const ids = [
    ...new Set([...before, ...after].map((block) => block.id)),
  ].filter(
    (id) =>
      hashStableValue(before.find((block) => block.id === id)) !==
      hashStableValue(after.find((block) => block.id === id)),
  );
  assertCompositeBlocks(value, ids);
}
function batchIdentity(value: z.infer<typeof summarySchema>) {
  const { expiresAt: _expires, warnings: _warnings, ...identity } = value;
  return compositeFingerprint(identity);
}
function assertBatchInspection(
  view: z.infer<typeof inspectionSchema>,
  batchId: string,
  offset: number,
  previous?: z.infer<typeof summarySchema>,
) {
  if (
    view.batchId !== batchId ||
    view.totalChanges > 5000 ||
    view.offset !== offset
  )
    throw scopeError();
  if (
    previous &&
    batchIdentity(previous) !== batchIdentity(summarySchema.parse(view))
  )
    throw scopeError();
}
