import { hashStableValue } from "../../shared/blockFingerprint";
import {
  libraryStructureResource,
  pageContentResource,
} from "../../shared/appActivityTypes";
import type { McpLibraryChangedEvent } from "../../shared/mcpEditingTypes";
import type {
  McpChapterDeletionRecovery,
  McpChapterDeletionTarget,
} from "../../shared/mcpChapterDeletion";
import {
  chapterDeletionApplied,
  chapterDeletionReceipt,
  chapterDeletionSnapshot,
  priorChapterDeletionAction,
  type ChapterDeletionRecord,
} from "../application/mcpChapterDeletionState";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  withLibraryRead,
  withLibraryMutation,
  withLibraryContentEdit,
} from "../library/lock";
import {
  prepareChapterDeletionUnlocked,
  stageChapterDeletionUnlocked,
} from "../libraryStore/libraryChapterDeletion";
import { stageWorkFile } from "../libraryStore/libraryTransactionFiles";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "../libraryStore/libraryTransaction";
import { logError } from "../logger";
import {
  McpChapterDeletionRepository,
  readChapterDeletionState,
  chapterDeletionDirectory,
} from "./mcpChapterDeletionRepository";
import { verifyChapterDeletionFiles } from "./mcpChapterDeletionFiles";

type Target = McpChapterDeletionTarget;
type Record = ChapterDeletionRecord;
export type ChapterDeletionEditor = {
  assertChapterClosed: (chapterId: string) => Promise<void>;
  notifyLibraryChanged?: (event: McpLibraryChangedEvent) => void;
};

/** Native composition only. The ordinary library ownership and transaction remain authoritative. */
export class McpChapterDeletionApplication {
  constructor(
    readonly repository: McpChapterDeletionRepository,
    private readonly editing?: ChapterDeletionEditor,
  ) {}
  preview(target: Target, guard: () => void) {
    return withLibraryRead(async () => {
      const state = await readChapterDeletionState(target, guard);
      if (!state.chapter || !state.tree)
        throw new McpEditError("not_found", "Chapter is not present.");
      await this.verifyState(target, state.snapshot, guard);
      return {
        ...summary(
          target,
          state.work.title,
          state.chapter.title,
          state.chapter.pages.length,
          state.tree,
        ),
        snapshot: state.snapshot,
        recovery: "seven-days-then-recovery-may-be-permanently-pruned" as const,
        warnings: [
          "chapter_directory_including_library_originals_will_be_removed",
          "external_source_files_are_not_touched",
          "encrypted_recovery_expires_after_seven_days",
          "target_must_be_closed_in_editor",
          "no_network_or_model_execution",
        ],
      };
    });
  }
  async apply(owner: string, input: Record["input"], guard: () => void) {
    guard();
    const previous = await withLibraryRead(() =>
      this.repository.find(owner, input),
    );
    guard();
    if (previous)
      return chapterDeletionReceipt(previous, input.requestId, "delete", true);
    const receipt = await this.mutate(input, async () => {
      const prior = await this.repository.find(owner, input);
      guard();
      if (prior)
        return chapterDeletionReceipt(prior, input.requestId, "delete", true);
      const state = await readChapterDeletionState(input, guard);
      if (!state.chapter || state.snapshot !== input.snapshot)
        throw new McpEditError(
          "revision_conflict",
          "Reviewed chapter or work changed. Review again; nothing was deleted.",
        );
      await this.assertClosed(input, guard);
      const change = await prepareChapterDeletionUnlocked(
        input.workId,
        input.chapterId,
      );
      if (hashStableValue(change.work) !== hashStableValue(state.work))
        throw new McpEditError(
          "revision_conflict",
          "Work changed during deletion preparation.",
        );
      const record = await runLibraryTransaction(
        "mcp-delete-chapter",
        async (transaction) => {
          const saved = await this.repository.publish(
            transaction,
            owner,
            input,
            state,
            change.after,
            guard,
          );
          await stageChapterDeletionUnlocked(
            transaction,
            change.after,
            input.chapterId,
          );
          transaction.beforePublish(async () => {
            await this.verifyState(input, input.snapshot, guard);
            await this.assertClosed(input, guard);
            this.repository.assertLive(saved);
          });
          return saved;
        },
        undefined,
        guard,
      );
      return chapterDeletionReceipt(record, input.requestId, "delete");
    });
    this.announce(receipt);
    return receipt;
  }
  inspect(owner: string, id: string, guard: () => void) {
    return withLibraryRead(async () => {
      guard();
      const record = await this.repository.load(owner, id);
      const state = await readChapterDeletionState(record.input, guard);
      await verifyChapterDeletionFiles(this.repository.storage, record, guard);
      this.repository.assertLive(record);
      await this.verifyState(record.input, state.snapshot, guard);
      const deleted = chapterDeletionApplied(record);
      const matches = state.snapshot === expectedSnapshot(record, deleted);
      const room = record.actions.length < 32;
      return {
        ...summary(
          record.input,
          record.before.title,
          record.chapterTitle,
          record.pageCount,
          record.tree,
        ),
        id,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        snapshot: state.snapshot,
        deleted,
        actionsUsed: record.actions.length,
        canUndo: matches && room && deleted,
        canRedo: matches && room && !deleted,
        warnings: [
          "availability_rechecked_at_publication",
          "target_must_be_closed_in_editor",
          ...(!matches ? ["later_library_changes_prevent_exact_recovery"] : []),
          ...(!room ? ["action_history_full"] : []),
        ],
      };
    });
  }
  async recover(
    owner: string,
    input: McpChapterDeletionRecovery,
    direction: "undo" | "redo",
    guard: () => void,
  ) {
    guard();
    const original = await withLibraryRead(() =>
      this.repository.load(owner, input.id),
    );
    guard();
    if (priorChapterDeletionAction(original, input, direction))
      return chapterDeletionReceipt(original, input.requestId, direction, true);
    const receipt = await this.mutate(original.input, async () => {
      const record = await this.repository.load(owner, input.id);
      guard();
      if (record.signature !== original.signature)
        throw new McpEditError(
          "revision_conflict",
          "Deletion recovery identity changed.",
        );
      if (priorChapterDeletionAction(record, input, direction))
        return chapterDeletionReceipt(record, input.requestId, direction, true);
      assertRecoveryAction(record, input, direction);
      const expected = expectedSnapshot(record, direction === "undo");
      await this.assertClosed(record.input, guard);
      await this.verifyState(record.input, expected, guard);
      await verifyChapterDeletionFiles(this.repository.storage, record, guard);
      const next = {
        ...record,
        actions: [
          ...record.actions,
          {
            requestId: input.requestId,
            direction,
            signature: hashStableValue({ input, direction }),
          },
        ],
      };
      await runLibraryTransaction(
        "mcp-recover-deleted-chapter",
        async (transaction) => {
          await this.stageRecovery(transaction, record, direction, guard);
          await this.repository.save(transaction, next);
          transaction.beforePublish(async () => {
            await this.verifyState(record.input, expected, guard);
            await verifyChapterDeletionFiles(
              this.repository.storage,
              record,
              guard,
            );
            if (
              hashStableValue(await this.repository.load(owner, record.id)) !==
              hashStableValue(record)
            )
              throw new McpEditError(
                "revision_conflict",
                "Recovery record changed before publication.",
              );
            await this.assertClosed(record.input, guard);
            this.repository.assertLive(record);
          });
        },
        undefined,
        guard,
      );
      return chapterDeletionReceipt(next, input.requestId, direction);
    });
    this.announce(receipt);
    return receipt;
  }
  private async stageRecovery(
    transaction: LibraryTransaction,
    record: Record,
    direction: "undo" | "redo",
    guard: () => void,
  ) {
    if (direction === "redo")
      return stageChapterDeletionUnlocked(
        transaction,
        record.after,
        record.input.chapterId,
      );
    const directory = await transaction.createPublishedDirectory(
      chapterDeletionDirectory(record.input),
    );
    await verifyChapterDeletionFiles(
      this.repository.storage,
      record,
      guard,
      directory.stagingDirectory,
    );
    await stageWorkFile(transaction, record.before);
  }
  async discard(owner: string, id: string, guard: () => void) {
    guard();
    const record = await withLibraryRead(() => this.repository.load(owner, id));
    return this.mutate(record.input, async () => {
      const current = await this.repository.load(owner, id);
      if (chapterDeletionApplied(current))
        throw new McpEditError(
          "invalid_edit",
          "Restore the chapter before discarding recovery. No early permanent-delete tool is provided.",
        );
      const expected = expectedSnapshot(current, false);
      await this.verifyState(current.input, expected, guard);
      await runLibraryTransaction(
        "mcp-discard-chapter-deletion",
        async (transaction) => {
          await this.repository.storage.retire(
            transaction,
            id,
            await this.repository.storage.index(),
          );
          transaction.beforePublish(async () => {
            await this.verifyState(current.input, expected, guard);
            if (
              hashStableValue(await this.repository.load(owner, id)) !==
              hashStableValue(current)
            )
              throw new McpEditError(
                "revision_conflict",
                "Recovery record changed before disposal.",
              );
          });
        },
        undefined,
        guard,
      );
      return { id, status: "discarded" as const, chapterChanges: 0 as const };
    });
  }
  private async verifyState(
    target: Target,
    expected: string,
    guard: () => void,
  ) {
    if ((await readChapterDeletionState(target, guard)).snapshot !== expected)
      throw new McpEditError(
        "revision_conflict",
        "Chapter or work changed before publication; later data is preserved.",
      );
    guard();
  }
  private async assertClosed(target: Target, guard: () => void) {
    guard();
    if (!this.editing)
      throw new McpEditError(
        "editor_busy",
        "Trusted editor probe is unavailable.",
      );
    await this.editing.assertChapterClosed(target.chapterId);
    guard();
  }
  private mutate<T>(target: Target, run: () => Promise<T>) {
    return withLibraryContentEdit(
      [
        libraryStructureResource("work", target.workId),
        libraryStructureResource("chapter", target.chapterId),
        pageContentResource(target.chapterId, "**"),
        { kind: "work-context", scope: target.workId, access: "write" },
      ],
      () => withLibraryMutation(run),
    );
  }
  private announce(receipt: ReturnType<typeof chapterDeletionReceipt>) {
    if (receipt.historical) return;
    try {
      this.editing?.notifyLibraryChanged?.({
        workId: receipt.workId,
        chapterId: receipt.chapterId,
      });
    } catch (error) {
      // error-policy-allow: publication committed; keep the durable receipt and report notification failure.
      receipt.warnings.push("notification_failed_after_commit");
      logError(
        "Chapter deletion/recovery saved; renderer notification failed",
        error,
      );
    }
  }
}
function expectedSnapshot(record: Record, deleted: boolean) {
  return chapterDeletionSnapshot(
    record.input,
    deleted ? record.after : record.before,
    deleted ? null : record.tree,
  );
}
function assertRecoveryAction(
  record: Record,
  input: McpChapterDeletionRecovery,
  direction: "undo" | "redo",
) {
  if (
    record.actions.length >= 32 ||
    chapterDeletionApplied(record) !== (direction === "undo")
  )
    throw new McpEditError(
      "invalid_edit",
      "Requested recovery action is unavailable.",
    );
  if (input.snapshot !== expectedSnapshot(record, direction === "undo"))
    throw new McpEditError(
      "revision_conflict",
      "Recovery requires the matching current snapshot.",
    );
}
function summary(
  target: Target,
  workTitle: string,
  chapterTitle: string,
  pageCount: number,
  tree: Record["tree"],
) {
  return {
    workId: target.workId,
    chapterId: target.chapterId,
    workTitle,
    chapterTitle,
    pageCount,
    fileCount: tree.files.length,
    directoryCount: tree.directories.length,
    sourceBytes: tree.files.reduce((sum, file) => sum + file.bytes, 0),
  };
}
