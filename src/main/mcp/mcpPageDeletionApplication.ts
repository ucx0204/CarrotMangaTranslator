import { hashStableValue } from "../../shared/blockFingerprint";
import {
  libraryStructureResource,
  pageContentResource,
} from "../../shared/appActivityTypes";
import type {
  McpPageDeletionApply,
  McpPageDeletionTarget,
} from "../../shared/mcpPageDeletion";
import type { McpChapterDeletionRecovery } from "../../shared/mcpChapterDeletion";
import {
  chapterDeletionApplied,
  priorChapterDeletionAction,
} from "../application/mcpChapterDeletionState";
import {
  PageDeletionRecordSchema,
  pageDeletionExpected,
  pageDeletionReceipt,
  type PageDeletionRecord,
} from "../application/mcpPageDeletionState";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  withLibraryRead,
  withLibraryMutation,
  withLibraryContentEdit,
} from "../library/lock";
import {
  preparePageDeletionFrame,
  preparePageDeletionUnlocked,
  stagePageDeletionUnlocked,
} from "../libraryStore/libraryPageDeletion";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import { logError } from "../logger";
import type { ChapterDeletionEditor } from "./mcpChapterDeletionApplication";
import {
  readPageDeletionState,
  pageDeletionAfterTree,
  describePageDeletion,
} from "./mcpPageDeletionEvidence";
import { stagePageDeletionRecovery } from "./mcpPageDeletionRestoration";
import type { McpPageDeletionRepository } from "./mcpPageDeletionRepository";
import {
  assertDeletionRecordUnchanged,
  stageDeletionRecoveryRecord,
  verifyCurrentDeletionRecord,
} from "./mcpDeletionRecoveryGuard";

type Record = PageDeletionRecord;
type Recovery = McpChapterDeletionRecovery;

/** Native composition: the existing activity gate, editor probe and transaction own all effects. */
export class McpPageDeletionApplication {
  constructor(
    readonly repository: McpPageDeletionRepository,
    private readonly editing?: ChapterDeletionEditor,
  ) {}
  preview(target: McpPageDeletionTarget, guard: () => void) {
    return withLibraryRead(async () => {
      const state = await readPageDeletionState(target, guard);
      if (!state.frame.chapter.pages.some((page) => page.id === target.pageId))
        throw new McpEditError("not_found", "Page is not present.");
      const after = preparePageDeletionFrame(
        state.frame,
        target.pageId,
        state.frame.chapter.updatedAt,
      );
      const tree = pageDeletionAfterTree(
        target,
        state.frame,
        after,
        state.tree,
      );
      await this.verifyState(target, state.snapshot, guard);
      return {
        ...describePageDeletion(target, state.frame, after, state.tree, tree),
        snapshot: state.snapshot,
        recovery: "seven-days-then-recovery-may-be-permanently-pruned" as const,
        warnings: [
          "selected_page_and_native_owned_assets_will_be_removed",
          "entire_chapter_is_archived_for_exact_recovery",
          "memory_is_reconciled_not_regenerated",
          "unselected_source_files_are_preserved",
          "target_chapter_must_be_closed_and_unlinked",
          "encrypted_recovery_expires_after_seven_days",
        ],
      };
    });
  }
  async apply(owner: string, input: McpPageDeletionApply, guard: () => void) {
    guard();
    const previous = await withLibraryRead(() =>
      this.repository.find(owner, input),
    );
    guard();
    if (previous)
      return pageDeletionReceipt(previous, input.requestId, "delete", true);
    const receipt = await this.mutate(input, async () => {
      const replay = await this.repository.find(owner, input);
      guard();
      if (replay)
        return pageDeletionReceipt(replay, input.requestId, "delete", true);
      const state = await this.verifyState(input, input.snapshot, guard);
      await this.assertClosed(input, guard);
      const { change } = await preparePageDeletionUnlocked(
        input.workId,
        input.chapterId,
        input.pageId,
      );
      if (
        !change ||
        hashStableValue(change.before) !== hashStableValue(state.frame)
      )
        throw new McpEditError(
          "revision_conflict",
          "Page deletion changed during preparation; review again.",
        );
      const record = await runLibraryTransaction(
        "mcp-delete-page",
        async (tx) => {
          const saved = await this.repository.publish(
            tx,
            owner,
            input,
            state,
            change.after,
            guard,
          );
          await stagePageDeletionUnlocked(tx, change);
          tx.beforePublish(async () => {
            await this.verifyState(input, input.snapshot, guard);
            await this.assertClosed(input, guard);
            this.repository.assertLive(saved);
          });
          return saved;
        },
        undefined,
        guard,
      );
      return pageDeletionReceipt(record, input.requestId, "delete");
    });
    return this.announce(receipt);
  }
  inspect(owner: string, id: string, guard: () => void) {
    return withLibraryRead(async () => {
      const record = await this.repository.load(owner, id);
      await this.repository.verify(record, guard);
      const state = await readPageDeletionState(record.input, guard);
      await this.verifyState(record.input, state.snapshot, guard);
      const deleted = chapterDeletionApplied(record);
      const matches = state.snapshot === pageDeletionExpected(record, deleted);
      const room = record.actions.length < 32;
      return {
        ...describe(record),
        id,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        snapshot: state.snapshot,
        deleted,
        actionsUsed: record.actions.length,
        canUndo: deleted && matches && room,
        canRedo: !deleted && matches && room,
        warnings: [
          "availability_rechecked_at_publication",
          "target_chapter_must_be_closed_and_unlinked",
          ...(!matches
            ? ["later_chapter_or_work_changes_prevent_exact_recovery"]
            : []),
          ...(!room ? ["action_history_full"] : []),
        ],
      };
    });
  }
  async recover(
    owner: string,
    input: Recovery,
    direction: "undo" | "redo",
    guard: () => void,
  ) {
    const original = await this.readVerified(owner, input.id, guard);
    if (priorChapterDeletionAction(original, input, direction))
      return pageDeletionReceipt(original, input.requestId, direction, true);
    const receipt = await this.mutate(original.input, async () => {
      const record = await this.repository.load(owner, input.id);
      guard();
      if (record.signature !== original.signature)
        throw new McpEditError(
          "revision_conflict",
          "Page recovery identity changed.",
        );
      if (priorChapterDeletionAction(record, input, direction))
        return pageDeletionReceipt(record, input.requestId, direction, true);
      assertAction(record, input, direction);
      const expected = pageDeletionExpected(record, direction === "undo");
      await this.assertClosed(record.input, guard);
      await this.verifyState(record.input, expected, guard);
      await this.repository.verify(record, guard);
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
        "mcp-recover-page-deletion",
        async (tx) => {
          await stagePageDeletionRecovery(
            tx,
            this.repository.storage,
            record,
            direction,
            guard,
          );
          await stageDeletionRecoveryRecord(
            tx,
            this.repository.storage,
            PageDeletionRecordSchema.parse(next),
          );
          tx.beforePublish(async () => {
            await this.verifyState(record.input, expected, guard);
            await verifyCurrentDeletionRecord(
              this.repository,
              owner,
              record,
              guard,
            );
            await this.repository.verify(record, guard);
            await this.assertClosed(record.input, guard);
          });
        },
        undefined,
        guard,
      );
      return pageDeletionReceipt(next, input.requestId, direction);
    });
    return this.announce(receipt);
  }
  async discard(owner: string, id: string, guard: () => void) {
    const original = await this.readVerified(owner, id, guard);
    return this.mutate(original.input, async () => {
      const record = await this.repository.load(owner, id);
      assertDeletionRecordUnchanged(original, record);
      if (chapterDeletionApplied(record))
        throw new McpEditError(
          "invalid_edit",
          "Restore the page before discarding recovery; no early permanent-delete tool is provided.",
        );
      const expected = pageDeletionExpected(record, false);
      await this.verifyState(record.input, expected, guard);
      await runLibraryTransaction(
        "mcp-discard-page-deletion",
        async (tx) => {
          await this.repository.storage.retire(
            tx,
            id,
            await this.repository.storage.index(),
          );
          tx.beforePublish(async () => {
            await this.verifyState(record.input, expected, guard);
            await verifyCurrentDeletionRecord(
              this.repository,
              owner,
              record,
              guard,
            );
          });
        },
        undefined,
        guard,
      );
      return { id, status: "discarded" as const, pageChanges: 0 as const };
    });
  }
  private readVerified(owner: string, id: string, guard: () => void) {
    return withLibraryRead(async () => {
      guard();
      const record = await this.repository.load(owner, id);
      await this.repository.verify(record, guard);
      return record;
    });
  }
  private async verifyState(
    target: McpPageDeletionTarget,
    snapshot: string,
    guard: () => void,
  ) {
    const state = await readPageDeletionState(target, guard);
    if (state.snapshot !== snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Chapter or work changed; later data is preserved.",
      );
    guard();
    return state;
  }
  private async assertClosed(target: McpPageDeletionTarget, guard: () => void) {
    guard();
    if (!this.editing)
      throw new McpEditError(
        "editor_busy",
        "Trusted editor probe is unavailable.",
      );
    await this.editing.assertChapterClosed(target.chapterId);
    guard();
  }
  private mutate<T>(target: McpPageDeletionTarget, action: () => Promise<T>) {
    return withLibraryContentEdit(
      [
        libraryStructureResource("work", target.workId),
        libraryStructureResource("chapter", target.chapterId),
        pageContentResource(target.chapterId, "**"),
        { kind: "work-context", scope: target.workId, access: "write" },
      ],
      () => withLibraryMutation(action),
    );
  }
  private announce(receipt: ReturnType<typeof pageDeletionReceipt>) {
    if (!receipt.historical) {
      try {
        this.editing?.notifyLibraryChanged?.({
          workId: receipt.workId,
          chapterId: receipt.chapterId,
        });
      } catch (error) {
        // error-policy-allow: page publication committed; keep the receipt and report notification failure.
        receipt.warnings.push("notification_failed_after_commit");
        logError(
          "Page deletion/recovery saved; renderer notification failed",
          error,
        );
      }
    }
    return receipt;
  }
}
function describe(record: Record) {
  return describePageDeletion(
    record.input,
    record.before,
    record.after,
    record.tree,
    record.afterTree,
  );
}
function assertAction(
  record: Record,
  input: Recovery,
  direction: "undo" | "redo",
) {
  if (
    record.actions.length >= 32 ||
    chapterDeletionApplied(record) !== (direction === "undo")
  )
    throw new McpEditError(
      "invalid_edit",
      "Requested page recovery action is unavailable.",
    );
  if (input.snapshot !== pageDeletionExpected(record, direction === "undo"))
    throw new McpEditError(
      "revision_conflict",
      "Use the matching current page recovery snapshot.",
    );
}
