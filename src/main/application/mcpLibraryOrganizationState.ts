import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import { ChapterStoryMemorySchema } from "../../shared/ipcWorkContextSchemas";
import {
  McpLibraryOrganizationApplySchema,
  type McpLibraryOrganizationRecovery,
} from "../../shared/mcpLibraryOrganization";
import { McpImportTargetSchema } from "../../shared/mcpLibraryImport";
import { McpEditError } from "./mcpEditPolicy";

const hash = McpLibraryOrganizationApplySchema.shape.snapshot;
const text = z.string().max(4096);
const timestamp = z.string().max(200);
const ids = z.array(McpImportTargetSchema.shape.workId).max(2000);
// Private recovery only; use the existing native memory schema, never a public patch.
const memory = z.unknown().transform((value, context) => {
  const parsed = ChapterStoryMemorySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  context.addIssue({ code: "custom", message: "Invalid saved story memory." });
  return z.NEVER;
});
const pageOrdering = z
  .object({
    order: ids,
    records: ids,
    status: z.enum(["idle", "running", "partial", "completed", "failed"]),
    memory: memory.nullable(),
  })
  .strict();
const fields = z
  .object({
    work: z
      .object({ title: text, chapterOrder: ids, updatedAt: timestamp })
      .strict(),
    chapter: z
      .object({ title: text, updatedAt: timestamp })
      .strict()
      .nullable(),
    pageOrdering: pageOrdering.optional(),
  })
  .strict();
const state = z.object({ fields, snapshot: hash }).strict();
const shape = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    owner: McpImportTargetSchema.shape.workId,
    input: McpLibraryOrganizationApplySchema,
    signature: hash,
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    before: state,
    after: state,
    actions: z
      .array(
        z
          .object({
            requestId: z.uuid(),
            signature: hash,
            direction: z.enum(["undo", "redo"]),
            snapshot: hash,
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
type RecordShape = z.infer<typeof shape>;
export const McpLibraryOrganizationRecordSchema = shape.refine(
  validRecord,
  "Inconsistent library metadata recovery record.",
);
export type McpLibraryOrganizationRecord = z.infer<
  typeof McpLibraryOrganizationRecordSchema
>;

function validRecord(record: RecordShape): boolean {
  const { before, after, input, actions } = record;
  const requests = [
    input.requestId,
    ...actions.map((action) => action.requestId),
  ];
  return (
    record.signature === hashStableValue(input) &&
    input.snapshot === before.snapshot &&
    record.expiresAt > record.createdAt &&
    sameInventory(
      before.fields.work.chapterOrder,
      after.fields.work.chapterOrder,
    ) &&
    new Set(requests).size === requests.length &&
    Boolean(before.fields.chapter) === "chapterId" in input.intent &&
    Boolean(after.fields.chapter) === Boolean(before.fields.chapter) &&
    validFields(record) &&
    validPageOrdering(record) &&
    actions.every(
      (action, index) =>
        action.direction === (index % 2 === 0 ? "undo" : "redo") &&
        action.snapshot ===
          (action.direction === "undo" ? before.snapshot : after.snapshot),
    )
  );
}
function validFields({ before, after, input }: RecordShape) {
  if (
    input.intent.kind === "reorder-pages" &&
    before.fields.chapter?.title !== after.fields.chapter?.title
  )
    return false;
  if (
    input.intent.kind !== "reorder-chapters" &&
    hashStableValue(before.fields.work.chapterOrder) !==
      hashStableValue(after.fields.work.chapterOrder)
  )
    return false;
  if (
    input.intent.kind !== "rename-work" &&
    before.fields.work.title !== after.fields.work.title
  )
    return false;
  if (
    "chapterId" in input.intent &&
    !before.fields.work.chapterOrder.includes(input.intent.chapterId)
  )
    return false;
  return true;
}
function sameInventory(left: string[], right: string[]) {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    hashStableValue([...left].sort()) === hashStableValue([...right].sort())
  );
}
function validPageOrdering({ before, after, input }: RecordShape) {
  const left = before.fields.pageOrdering,
    right = after.fields.pageOrdering;
  if (input.intent.kind !== "reorder-pages") return !left && !right;
  if (!left || !right) return false;
  const intent = input.intent;
  return (
    sameInventory(left.order, left.records) &&
    sameInventory(left.order, right.order) &&
    sameInventory(right.records, right.order) &&
    hashStableValue(right.order) === hashStableValue(intent.pageIds) &&
    (left.memory === null) === (right.memory === null) &&
    [left.memory, right.memory].every(
      (value) =>
        value === null ||
        (value.workId === intent.workId &&
          value.chapterId === intent.chapterId),
    )
  );
}
export function libraryChangeApplied(record: McpLibraryOrganizationRecord) {
  return record.actions.at(-1)?.direction !== "undo";
}
export function priorLibraryChangeAction(
  record: McpLibraryOrganizationRecord,
  input: McpLibraryOrganizationRecovery,
  direction: "undo" | "redo",
) {
  if (record.input.requestId === input.requestId)
    throw new McpEditError(
      "invalid_edit",
      "Recovery needs a new requestId, not the original edit ID.",
    );
  const prior = record.actions.find(
    (action) => action.requestId === input.requestId,
  );
  if (prior && prior.signature !== hashStableValue({ direction, input }))
    throw new McpEditError(
      "invalid_edit",
      "Request ID belongs to another library recovery action.",
    );
  return prior;
}
export function libraryChangeReceipt(
  record: McpLibraryOrganizationRecord,
  requestId: string,
  direction: "apply" | "undo" | "redo",
  historical = false,
) {
  return {
    id: record.id,
    requestId,
    direction,
    status: historical
      ? ("already_applied" as const)
      : record.before.snapshot === record.after.snapshot
        ? ("unchanged" as const)
        : ("saved" as const),
    historical,
    snapshot:
      direction === "undo" ? record.before.snapshot : record.after.snapshot,
    expiresAt: record.expiresAt,
    warnings: historical ? ["historical_receipt_not_current_state"] : [],
  };
}
