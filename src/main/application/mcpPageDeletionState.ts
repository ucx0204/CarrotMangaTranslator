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
  McpPageDeletionApplySchema,
  type McpPageDeletionTarget,
} from "../../shared/mcpPageDeletion";
import {
  ChapterDeletionRecordSchema,
  ChapterDeletionTreeSchema,
  type ChapterDeletionTree,
} from "./mcpChapterDeletionState";

const frame = z
  .object({
    work: z.custom<LibraryWork>(
      (value) => LibraryWorkFileSchema.safeParse(value).success,
    ),
    chapter: z.custom<LibraryChapter>(
      (value) => LibraryChapterFileSchema.safeParse(value).success,
    ),
    memory: z
      .custom<ChapterStoryMemory>(
        (value) => ChapterStoryMemorySchema.safeParse(value).success,
      )
      .nullable(),
  })
  .strict();
const common = ChapterDeletionRecordSchema.shape;
const shape = z
  .object({
    format: common.format,
    id: common.id,
    owner: common.owner,
    createdAt: common.createdAt,
    expiresAt: common.expiresAt,
    signature: common.signature,
    parts: common.parts,
    actions: common.actions,
    input: McpPageDeletionApplySchema,
    before: frame,
    after: frame,
    tree: ChapterDeletionTreeSchema,
    afterTree: ChapterDeletionTreeSchema,
  })
  .strict();
export type PageDeletionRecord = z.infer<typeof shape>;
export const PageDeletionRecordSchema = shape.refine((record) => {
  const { input, before, after, actions } = record;
  const requests = [
    input.requestId,
    ...actions.map((action) => action.requestId),
  ];
  return (
    validTargetFrames(before, after, input) &&
    record.signature === hashStableValue(input) &&
    record.expiresAt > record.createdAt &&
    input.snapshot === pageDeletionSnapshot(input, before.work, record.tree) &&
    record.parts.length === record.tree.files.length &&
    new Set(requests).size === requests.length &&
    actions.every(
      (action, index) => action.direction === (index % 2 ? "redo" : "undo"),
    )
  );
}, "Inconsistent page deletion recovery record.");

export function pageDeletionSnapshot(
  target: McpPageDeletionTarget,
  work: LibraryWork,
  tree: ChapterDeletionTree,
) {
  return hashStableValue({
    target: {
      workId: target.workId,
      chapterId: target.chapterId,
      pageId: target.pageId,
    },
    work,
    tree,
  });
}
export function pageDeletionExpected(
  record: PageDeletionRecord,
  deleted: boolean,
) {
  return pageDeletionSnapshot(
    record.input,
    deleted ? record.after.work : record.before.work,
    deleted ? record.afterTree : record.tree,
  );
}
export function pageDeletionReceipt(
  record: PageDeletionRecord,
  requestId: string,
  direction: "delete" | "undo" | "redo",
  historical = false,
) {
  return {
    id: record.id,
    requestId,
    workId: record.input.workId,
    chapterId: record.input.chapterId,
    pageId: record.input.pageId,
    direction,
    status: historical ? ("already_applied" as const) : ("saved" as const),
    historical,
    expiresAt: record.expiresAt,
    snapshot: pageDeletionExpected(record, direction !== "undo"),
    warnings: historical ? ["historical_receipt_not_current_state"] : [],
  };
}

function validTargetFrames(
  before: PageDeletionRecord["before"],
  after: PageDeletionRecord["after"],
  input: McpPageDeletionTarget,
) {
  return (
    before.work.id === input.workId &&
    before.chapter.id === input.chapterId &&
    before.chapter.workId === input.workId &&
    before.work.chapterOrder.includes(input.chapterId) &&
    before.chapter.pages.length <= 50 &&
    before.chapter.pages.some((page) => page.id === input.pageId) &&
    after.work.id === input.workId &&
    after.chapter.id === input.chapterId
  );
}
