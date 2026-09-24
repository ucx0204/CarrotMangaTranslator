import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  LibraryChapterFileSchema,
  LibraryWorkFileSchema,
} from "../../shared/ipcLibrarySchemas";
import { ChapterStoryMemorySchema } from "../../shared/ipcWorkContextSchemas";
import type { LibraryChapter, LibraryWork } from "../../shared/libraryTypes";
import type { ChapterStoryMemory } from "../../shared/workContextTypes";
import {
  McpChapterMoveApplySchema,
  type McpChapterMoveIntent,
} from "../../shared/mcpChapterMove";
import type { McpChapterDeletionRecovery } from "../../shared/mcpChapterDeletion";
import {
  ChapterDeletionTreeSchema,
  type ChapterDeletionTree,
} from "./mcpChapterDeletionState";
import { McpEditError } from "./mcpEditPolicy";

const hash = McpChapterMoveApplySchema.shape.snapshot;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const work = z.custom<LibraryWork>(
  (value) => LibraryWorkFileSchema.safeParse(value).success,
);
const chapter = z.custom<LibraryChapter>(
  (value) => LibraryChapterFileSchema.safeParse(value).success,
);
const memory = z.custom<ChapterStoryMemory>(
  (value) => ChapterStoryMemorySchema.safeParse(value).success,
);
const frame = z
  .object({
    works: z.tuple([work, work]),
    guides: z.tuple([digest.nullable(), digest.nullable()]),
    siblings: z.tuple([hash, hash]),
  })
  .strict();
export type ChapterMoveFrame = z.infer<typeof frame>;
const shape = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    owner: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    input: McpChapterMoveApplySchema,
    signature: hash,
    createdAt: count,
    expiresAt: count,
    before: frame,
    after: frame,
    tree: ChapterDeletionTreeSchema,
    afterTree: ChapterDeletionTreeSchema,
    parts: z.array(z.array(digest).max(128)).max(2000),
    afterChapter: chapter,
    afterMemory: memory.nullable(),
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
export type ChapterMoveRecord = z.infer<typeof shape>;
export const ChapterMoveRecordSchema = shape.refine(
  validRecord,
  "Inconsistent chapter movement recovery.",
);

export function chapterMoveSnapshot(
  intent: McpChapterMoveIntent,
  state: ChapterMoveFrame,
  tree: ChapterDeletionTree,
  moved: boolean,
) {
  return hashStableValue({
    workId: intent.workId,
    destinationWorkId: intent.destinationWorkId,
    chapterId: intent.chapterId,
    state,
    tree,
    moved,
  });
}
function validRecord(record: ChapterMoveRecord) {
  const { input, before, after, afterChapter, afterMemory } = record;
  const { intent } = input;
  const index =
    intent.beforeChapterId === undefined
      ? before.works[1].chapterOrder.length
      : before.works[1].chapterOrder.indexOf(intent.beforeChapterId);
  const order = [...before.works[1].chapterOrder];
  order.splice(index, 0, intent.chapterId);
  const expected: ChapterMoveFrame = {
    ...before,
    works: [
      {
        ...before.works[0],
        chapterOrder: before.works[0].chapterOrder.filter(
          (id) => id !== intent.chapterId,
        ),
        updatedAt: after.works[0].updatedAt,
      },
      {
        ...before.works[1],
        chapterOrder: order,
        updatedAt: after.works[1].updatedAt,
      },
    ],
  };
  return (
    index >= 0 &&
    validMembership(record) &&
    hashStableValue(expected) === hashStableValue(after) &&
    record.signature === hashStableValue(input) &&
    record.expiresAt > record.createdAt &&
    input.snapshot ===
      chapterMoveSnapshot(intent, before, record.tree, false) &&
    afterChapter.id === intent.chapterId &&
    afterChapter.workId === intent.destinationWorkId &&
    afterChapter.pages.length <= 50 &&
    validMemory(afterMemory, record) &&
    validActions(record)
  );
}
function validMembership({ before, input }: ChapterMoveRecord) {
  const [source, destination] = before.works;
  return (
    source.id === input.intent.workId &&
    destination.id === input.intent.destinationWorkId &&
    source.chapterOrder.includes(input.intent.chapterId) &&
    !destination.chapterOrder.includes(input.intent.chapterId) &&
    before.works.every(
      (item) =>
        new Set(item.chapterOrder).size === item.chapterOrder.length &&
        item.chapterOrder.length <= 2000,
    )
  );
}
function validMemory(
  memory: ChapterStoryMemory | null,
  record: ChapterMoveRecord,
) {
  const present = record.tree.files.some(
    (file) => file.path === "story-memory.json",
  );
  return (
    present === (memory !== null) &&
    (!memory ||
      (memory.workId === record.input.intent.destinationWorkId &&
        memory.chapterId === record.input.intent.chapterId))
  );
}
export function chapterMoveApplied(record: ChapterMoveRecord) {
  return record.actions.at(-1)?.direction !== "undo";
}
export function priorChapterMoveAction(
  record: ChapterMoveRecord,
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
      "Request ID belongs to another movement recovery.",
    );
  return prior;
}
export function chapterMoveReceipt(
  record: ChapterMoveRecord,
  requestId: string,
  direction: "move" | "undo" | "redo",
  historical = false,
) {
  const moved = direction !== "undo";
  return {
    id: record.id,
    requestId,
    chapterId: record.input.intent.chapterId,
    workId: record.input.intent.workId,
    destinationWorkId: record.input.intent.destinationWorkId,
    direction,
    status: historical ? ("already_applied" as const) : ("saved" as const),
    historical,
    snapshot: chapterMoveSnapshot(
      record.input.intent,
      moved ? record.after : record.before,
      moved ? record.afterTree : record.tree,
      moved,
    ),
    expiresAt: record.expiresAt,
    warnings: historical ? ["historical_receipt_not_current_state"] : [],
  };
}

function validActions(record: ChapterMoveRecord) {
  const { input, actions } = record;
  const requests = [input.requestId, ...actions.map((item) => item.requestId)];
  return (
    record.parts.length === record.tree.files.length &&
    new Set(requests).size === requests.length &&
    actions.every((item, i) => item.direction === (i % 2 ? "redo" : "undo"))
  );
}
