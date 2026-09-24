import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import { StoredLibraryIndexFileSchema } from "../../shared/ipcLibrarySchemas";
import {
  McpWorkDeletionApplySchema,
  mcpWorkDeletionOutputs,
} from "../../shared/mcpWorkDeletion";
import type { McpChapterDeletionRecovery } from "../../shared/mcpChapterDeletion";
import {
  ChapterDeletionTreeSchema,
  type ChapterDeletionTree,
} from "./mcpChapterDeletionState";
import { McpEditError } from "./mcpEditPolicy";

const hash = McpWorkDeletionApplySchema.shape.snapshot;
const index = z
  .custom<{
    workOrder: string[];
  }>((value) => StoredLibraryIndexFileSchema.safeParse(value).success)
  .refine(
    (value) =>
      value.workOrder.length <= 2000 &&
      new Set(value.workOrder).size === value.workOrder.length,
    "A bounded, distinct work inventory is required.",
  );
const summary = mcpWorkDeletionOutputs.carrot_preview_work_deletion.pick({
  workTitle: true,
  chapters: true,
  pageCount: true,
});
const shape = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    owner: McpWorkDeletionApplySchema.shape.workId,
    input: McpWorkDeletionApplySchema,
    signature: hash,
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    before: index,
    after: index,
    summary,
    tree: ChapterDeletionTreeSchema,
    parts: z
      .array(z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(128))
      .max(2000),
    actions: z
      .array(
        z
          .object({
            requestId: z.uuid(),
            signature: hash,
            direction: z.enum(["undo", "redo"]),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type WorkDeletionRecord = z.infer<typeof shape>;
export const WorkDeletionRecordSchema = shape.refine((record) => {
  const { input, before, after, actions } = record;
  const requests = [input.requestId, ...actions.map((item) => item.requestId)];
  const chapters = record.summary.chapters;
  return (
    before.workOrder.includes(input.workId) &&
    hashStableValue(after) ===
      hashStableValue({
        workOrder: before.workOrder.filter((id) => id !== input.workId),
      }) &&
    record.signature === hashStableValue(input) &&
    record.expiresAt > record.createdAt &&
    input.snapshot ===
      workDeletionSnapshot(input.workId, before, record.tree) &&
    record.parts.length === record.tree.files.length &&
    new Set(requests).size === requests.length &&
    new Set(chapters.map((item) => item.chapterId)).size === chapters.length &&
    record.summary.pageCount ===
      chapters.reduce((sum, item) => sum + item.pageCount, 0) &&
    actions.every((item, i) => item.direction === (i % 2 ? "redo" : "undo"))
  );
}, "Inconsistent work deletion recovery.");

export function workDeletionSnapshot(
  workId: string,
  library: z.infer<typeof index>,
  tree: ChapterDeletionTree | null,
) {
  return hashStableValue({ workId, library, tree });
}
export function workDeletionApplied(record: WorkDeletionRecord) {
  return record.actions.at(-1)?.direction !== "undo";
}
export function expectedWorkDeletionSnapshot(
  record: WorkDeletionRecord,
  deleted: boolean,
) {
  return workDeletionSnapshot(
    record.input.workId,
    deleted ? record.after : record.before,
    deleted ? null : record.tree,
  );
}
export function priorWorkDeletionAction(
  record: WorkDeletionRecord,
  input: McpChapterDeletionRecovery,
  direction: "undo" | "redo",
) {
  if (input.requestId === record.input.requestId)
    throw new McpEditError("invalid_edit", "Recovery needs a new request ID.");
  const prior = record.actions.find(
    (item) => item.requestId === input.requestId,
  );
  if (prior && prior.signature !== hashStableValue({ input, direction }))
    throw new McpEditError(
      "invalid_edit",
      "Request ID belongs to a different work recovery.",
    );
  return prior;
}
export function workDeletionReceipt(
  record: WorkDeletionRecord,
  requestId: string,
  direction: "delete" | "undo" | "redo",
  historical = false,
) {
  return {
    id: record.id,
    requestId,
    workId: record.input.workId,
    direction,
    status: historical ? ("already_applied" as const) : ("saved" as const),
    historical,
    expiresAt: record.expiresAt,
    snapshot: expectedWorkDeletionSnapshot(record, direction !== "undo"),
    warnings: historical ? ["historical_receipt_not_current_state"] : [],
  };
}

/** Plan action history before any filesystem effect; concurrent duplicate requests remain historical. */
export function planWorkDeletionRecovery(
  record: WorkDeletionRecord,
  original: WorkDeletionRecord,
  input: McpChapterDeletionRecovery,
  direction: "undo" | "redo",
) {
  if (
    hashStableValue({ ...record, actions: [] }) !==
    hashStableValue({ ...original, actions: [] })
  )
    throw new McpEditError(
      "revision_conflict",
      "Work recovery identity changed during admission.",
    );
  if (priorWorkDeletionAction(record, input, direction))
    return { record, historical: true };
  if (
    record.actions.length >= 32 ||
    workDeletionApplied(record) !== (direction === "undo")
  )
    throw new McpEditError(
      "invalid_edit",
      "Requested work recovery is unavailable.",
    );
  if (
    input.snapshot !==
    expectedWorkDeletionSnapshot(record, direction === "undo")
  )
    throw new McpEditError(
      "revision_conflict",
      "Use the matching current work recovery snapshot.",
    );
  return {
    historical: false,
    record: {
      ...record,
      actions: [
        ...record.actions,
        {
          requestId: input.requestId,
          direction,
          signature: hashStableValue({ input, direction }),
        },
      ],
    },
  };
}
