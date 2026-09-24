import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import { LibraryWorkFileSchema } from "../../shared/ipcLibrarySchemas";
import type { LibraryWork } from "../../shared/libraryTypes";
import {
  McpChapterDeletionApplySchema,
  MCP_CHAPTER_DELETION_BYTES,
  MCP_CHAPTER_DELETION_ENTRIES,
  type McpChapterDeletionTarget,
  type McpChapterDeletionRecovery,
} from "../../shared/mcpChapterDeletion";
import { McpEditError } from "./mcpEditPolicy";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096);
const count = z.number().int().nonnegative();
const file = z
  .object({ path, bytes: count.max(128 * 1024 * 1024), sha256: digest })
  .strict();
export const RecoveryDirectoryTreeSchema = z
  .object({
    directories: z.array(path).max(MCP_CHAPTER_DELETION_ENTRIES),
    files: z.array(file).max(MCP_CHAPTER_DELETION_ENTRIES),
  })
  .strict()
  .refine(
    (tree) =>
      tree.directories.length + tree.files.length <=
        MCP_CHAPTER_DELETION_ENTRIES &&
      tree.files.reduce((sum, value) => sum + value.bytes, 0) <=
        MCP_CHAPTER_DELETION_BYTES,
    "Chapter recovery inventory exceeds its budget.",
  );
export const ChapterDeletionTreeSchema = RecoveryDirectoryTreeSchema.refine(
  (tree) => tree.files.length > 0,
  "Chapter recovery requires metadata.",
);
export type ChapterDeletionTree = z.infer<typeof ChapterDeletionTreeSchema>;
const work = z.custom<LibraryWork>(
  (value) => LibraryWorkFileSchema.safeParse(value).success,
);
const hash = McpChapterDeletionApplySchema.shape.snapshot;
const shape = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    owner: McpChapterDeletionApplySchema.shape.workId,
    input: McpChapterDeletionApplySchema,
    signature: hash,
    createdAt: count,
    expiresAt: count,
    before: work,
    after: work,
    chapterTitle: z.string().max(4096),
    pageCount: count.max(50),
    tree: ChapterDeletionTreeSchema,
    parts: z.array(z.array(digest).max(128)).max(MCP_CHAPTER_DELETION_ENTRIES),
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
export type ChapterDeletionRecord = z.infer<typeof shape>;
export const ChapterDeletionRecordSchema = shape.refine(
  validRecord,
  "Inconsistent chapter deletion recovery record.",
);

export function chapterDeletionSnapshot(
  target: McpChapterDeletionTarget,
  work: LibraryWork,
  tree: ChapterDeletionTree | null,
) {
  return hashStableValue({
    target: { workId: target.workId, chapterId: target.chapterId },
    work,
    tree,
  });
}
function validRecord(record: ChapterDeletionRecord) {
  const { before, after, input, tree, actions } = record;
  const requests = [input.requestId, ...actions.map((item) => item.requestId)];
  const expected = {
    ...before,
    chapterOrder: before.chapterOrder.filter((id) => id !== input.chapterId),
    updatedAt: after.updatedAt,
  };
  return (
    before.id === input.workId &&
    before.chapterOrder.includes(input.chapterId) &&
    new Set(before.chapterOrder).size === before.chapterOrder.length &&
    hashStableValue(expected) === hashStableValue(after) &&
    record.signature === hashStableValue(input) &&
    record.expiresAt > record.createdAt &&
    input.snapshot === chapterDeletionSnapshot(input, before, tree) &&
    record.parts.length === tree.files.length &&
    new Set(requests).size === requests.length &&
    actions.every(
      (action, index) => action.direction === (index % 2 ? "redo" : "undo"),
    )
  );
}
export function chapterDeletionApplied(
  record: Pick<ChapterDeletionRecord, "actions">,
) {
  return record.actions.at(-1)?.direction !== "undo";
}
export function priorChapterDeletionAction(
  record: {
    input: { requestId: string };
    actions: ChapterDeletionRecord["actions"];
  },
  input: McpChapterDeletionRecovery,
  direction: "undo" | "redo",
) {
  if (input.requestId === record.input.requestId)
    throw new McpEditError("invalid_edit", "Recovery needs a new requestId.");
  const prior = record.actions.find(
    (item) => item.requestId === input.requestId,
  );
  if (prior && prior.signature !== hashStableValue({ input, direction }))
    throw new McpEditError(
      "invalid_edit",
      "Request ID belongs to another recovery action.",
    );
  return prior;
}
export function chapterDeletionReceipt(
  record: ChapterDeletionRecord,
  requestId: string,
  direction: "delete" | "undo" | "redo",
  historical = false,
) {
  const undo = direction === "undo";
  return {
    id: record.id,
    requestId,
    workId: record.input.workId,
    chapterId: record.input.chapterId,
    direction,
    status: historical ? ("already_applied" as const) : ("saved" as const),
    historical,
    expiresAt: record.expiresAt,
    snapshot: chapterDeletionSnapshot(
      record.input,
      undo ? record.before : record.after,
      undo ? record.tree : null,
    ),
    warnings: historical ? ["historical_receipt_not_current_state"] : [],
  };
}
