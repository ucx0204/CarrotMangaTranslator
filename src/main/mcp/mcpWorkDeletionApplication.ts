import { hashStableValue } from "../../shared/blockFingerprint";
import {
  libraryStructureResource,
  pageContentResource,
  type AppActivityResource,
} from "../../shared/appActivityTypes";
import type { McpWorkDeletionApply } from "../../shared/mcpWorkDeletion";
import type { McpChapterDeletionRecovery } from "../../shared/mcpChapterDeletion";
import {
  workDeletionApplied,
  workDeletionReceipt,
  expectedWorkDeletionSnapshot,
  priorWorkDeletionAction,
  planWorkDeletionRecovery,
  type WorkDeletionRecord,
} from "../application/mcpWorkDeletionState";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  withLibraryRead,
  withLibraryMutation,
  withLibraryContentEdit,
} from "../library/lock";
import {
  prepareWorkDeletionUnlocked,
  stageWorkDeletionUnlocked,
} from "../libraryStore/libraryWorkDeletion";
import { stageIndexFile } from "../libraryStore/libraryTransactionFiles";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import { logError } from "../logger";
import type { ChapterDeletionEditor } from "./mcpChapterDeletionApplication";
import {
  readWorkDeletionState,
  assertWorkDeletionUnlinked,
  assertWorkDeletionChapterIdentities,
} from "./mcpWorkDeletionEvidence";
import { McpWorkDeletionRepository } from "./mcpWorkDeletionRepository";

type Record = WorkDeletionRecord;
const chapterIds = (summary: Record["summary"]) =>
  summary.chapters.map((chapter) => chapter.chapterId);

/** Whole-work removal is a distinct reviewed operation, not a loop of chapter deletions. */
export class McpWorkDeletionApplication {
  constructor(
    private readonly repository: McpWorkDeletionRepository,
    private readonly editing?: ChapterDeletionEditor,
  ) {}

  preview(workId: string, guard: () => void) {
    return withLibraryRead(async () => {
      const state = await readWorkDeletionState(workId, guard);
      if (!state.tree || !state.summary)
        throw new McpEditError("not_found", "Work is not present.");
      await assertWorkDeletionUnlinked(
        workId,
        chapterIds(state.summary),
        guard,
      );
      await this.verifyState(workId, state.snapshot, guard);
      return {
        ...describe(workId, state.summary, state.tree),
        snapshot: state.snapshot,
        recovery: "seven-days-then-recovery-may-be-permanently-pruned" as const,
        warnings: [
          "whole_work_including_chapters_originals_context_and_run_files_will_be_removed",
          "external_source_and_mirror_folders_are_not_touched",
          "recovery_is_not_permanent_trash; expires_after_seven_days",
          "all_chapters_must_be_closed_and_unlinked",
          "no_network_or_model_execution",
        ],
      };
    });
  }
  async apply(owner: string, input: McpWorkDeletionApply, guard: () => void) {
    const first = await withLibraryRead(async () => {
      guard();
      const prior = await this.repository.find(owner, input);
      return prior
        ? { prior }
        : { state: await readWorkDeletionState(input.workId, guard) };
    });
    guard();
    if (first.prior)
      return workDeletionReceipt(first.prior, input.requestId, "delete", true);
    if (!first.state?.summary)
      throw new McpEditError("not_found", "Reviewed work is unavailable.");
    const receipt = await this.mutate(
      input.workId,
      chapterIds(first.state.summary),
      async () => {
        const prior = await this.repository.find(owner, input);
        guard();
        if (prior)
          return workDeletionReceipt(prior, input.requestId, "delete", true);
        const state = await this.verifyState(
          input.workId,
          input.snapshot,
          guard,
        );
        if (!state.summary)
          throw new McpEditError("not_found", "Work is already absent.");
        const ids = chapterIds(state.summary);
        await this.assertClosed(input.workId, ids, guard);
        const change = await prepareWorkDeletionUnlocked(input.workId);
        if (hashStableValue(change.index) !== hashStableValue(state.index))
          throw new McpEditError(
            "revision_conflict",
            "Library changed during native deletion preparation.",
          );
        const saved = await runLibraryTransaction(
          "mcp-delete-work",
          async (transaction) => {
            const record = await this.repository.retain(
              transaction,
              owner,
              input,
              state,
              change.after,
              guard,
            );
            await stageWorkDeletionUnlocked(
              transaction,
              input.workId,
              change.after,
            );
            transaction.beforePublish(async () => {
              await this.verifyState(input.workId, input.snapshot, guard);
              await this.assertClosed(input.workId, ids, guard);
              this.repository.assertLive(record);
            });
            return record;
          },
          undefined,
          guard,
        );
        return workDeletionReceipt(saved, input.requestId, "delete");
      },
    );
    this.announce(receipt);
    return receipt;
  }
  inspect(owner: string, id: string, guard: () => void) {
    return withLibraryRead(async () => {
      guard();
      const record = await this.repository.load(owner, id);
      await this.repository.verify(record, guard);
      const state = await readWorkDeletionState(record.input.workId, guard);
      await this.verifyState(record.input.workId, state.snapshot, guard);
      await assertWorkDeletionChapterIdentities(
        record.input.workId,
        chapterIds(record.summary),
        guard,
      );
      const deleted = workDeletionApplied(record);
      const available =
        state.snapshot === expectedWorkDeletionSnapshot(record, deleted) &&
        record.actions.length < 32;
      this.repository.assertLive(record);
      return {
        ...describe(record.input.workId, record.summary, record.tree),
        id,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        snapshot: state.snapshot,
        deleted,
        actionsUsed: record.actions.length,
        canUndo: available && deleted,
        canRedo: available && !deleted,
        warnings: [
          "availability_rechecked_at_publication",
          "all_chapters_must_be_closed_and_unlinked",
          ...(!available
            ? ["later_library_changes_or_action_limit_prevent_exact_recovery"]
            : []),
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
    const original = await this.readVerified(owner, input.id, guard);
    if (priorWorkDeletionAction(original, input, direction))
      return workDeletionReceipt(original, input.requestId, direction, true);
    const receipt = await this.mutate(
      original.input.workId,
      chapterIds(original.summary),
      async () => {
        const record = await this.repository.load(owner, input.id);
        const plan = planWorkDeletionRecovery(
          record,
          original,
          input,
          direction,
        );
        if (plan.historical)
          return workDeletionReceipt(record, input.requestId, direction, true);
        await this.repository.verify(record, guard);
        await this.verifyState(record.input.workId, input.snapshot, guard);
        await this.assertClosed(
          record.input.workId,
          chapterIds(record.summary),
          guard,
        );
        await runLibraryTransaction(
          "mcp-recover-deleted-work",
          async (transaction) => {
            if (direction === "redo")
              await stageWorkDeletionUnlocked(
                transaction,
                record.input.workId,
                record.after,
              );
            else {
              await this.repository.stageRestoration(
                transaction,
                record,
                guard,
              );
              await stageIndexFile(transaction, record.before);
            }
            await this.repository.save(transaction, plan.record);
            transaction.beforePublish(async () => {
              await this.verifyState(
                record.input.workId,
                input.snapshot,
                guard,
              );
              await this.repository.verify(record, guard);
              await this.verifyRecord(owner, record, guard);
              await this.assertClosed(
                record.input.workId,
                chapterIds(record.summary),
                guard,
              );
            });
          },
          undefined,
          guard,
        );
        return workDeletionReceipt(plan.record, input.requestId, direction);
      },
    );
    this.announce(receipt);
    return receipt;
  }
  async discard(owner: string, id: string, guard: () => void) {
    const original = await this.readVerified(owner, id, guard);
    return this.mutate(
      original.input.workId,
      chapterIds(original.summary),
      async () => {
        const record = await this.repository.load(owner, id);
        if (hashStableValue(original) !== hashStableValue(record))
          throw new McpEditError(
            "revision_conflict",
            "Work recovery changed during disposal admission.",
          );
        if (workDeletionApplied(record))
          throw new McpEditError(
            "invalid_edit",
            "Restore the complete work before discarding recovery. No early permanent purge is provided.",
          );
        const expected = expectedWorkDeletionSnapshot(record, false);
        await this.verifyState(record.input.workId, expected, guard);
        await runLibraryTransaction(
          "mcp-discard-work-deletion",
          async (transaction) => {
            await this.repository.storage.retire(
              transaction,
              id,
              await this.repository.storage.index(),
            );
            transaction.beforePublish(async () => {
              await this.verifyState(record.input.workId, expected, guard);
              await this.verifyRecord(owner, record, guard);
            });
          },
          undefined,
          guard,
        );
        return { id, status: "discarded" as const, workChanges: 0 as const };
      },
    );
  }
  private readVerified(owner: string, id: string, guard: () => void) {
    return withLibraryRead(async () => {
      guard();
      const record = await this.repository.load(owner, id);
      await this.repository.verify(record, guard);
      return record;
    });
  }
  private async verifyRecord(owner: string, record: Record, guard: () => void) {
    if (
      hashStableValue(await this.repository.load(owner, record.id)) !==
      hashStableValue(record)
    )
      throw new McpEditError(
        "revision_conflict",
        "Work recovery changed before publication.",
      );
    this.repository.assertLive(record);
    guard();
  }
  private async verifyState(
    workId: string,
    snapshot: string,
    guard: () => void,
  ) {
    const state = await readWorkDeletionState(workId, guard);
    if (state.snapshot !== snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Library or work changed; later data is preserved.",
      );
    guard();
    return state;
  }
  private async assertClosed(workId: string, ids: string[], guard: () => void) {
    if (!this.editing)
      throw new McpEditError(
        "editor_busy",
        "Trusted editor probe is unavailable.",
      );
    await assertWorkDeletionChapterIdentities(workId, ids, guard);
    await assertWorkDeletionUnlinked(workId, ids, guard);
    for (const id of ids) {
      guard();
      await this.editing.assertChapterClosed(id);
    }
    guard();
  }
  private mutate<T>(workId: string, ids: string[], run: () => Promise<T>) {
    const resources: AppActivityResource[] = [
      { kind: "library-structure", scope: "*", access: "write" },
      { kind: "work-context", scope: workId, access: "write" },
      ...ids.flatMap((id) => [
        libraryStructureResource("chapter", id),
        pageContentResource(id, "**"),
      ]),
    ];
    return withLibraryContentEdit(resources, () => withLibraryMutation(run));
  }
  private announce(receipt: ReturnType<typeof workDeletionReceipt>) {
    if (receipt.historical) return;
    try {
      this.editing?.notifyLibraryChanged?.({ workId: receipt.workId });
    } catch (error) {
      // error-policy-allow: work publication committed; preserve its receipt and expose notification failure.
      receipt.warnings.push("notification_failed_after_commit");
      logError(
        "Work deletion/recovery saved; renderer notification failed",
        error,
      );
    }
  }
}
function describe(
  workId: string,
  summary: Record["summary"],
  tree: Record["tree"],
) {
  return {
    workId,
    ...summary,
    fileCount: tree.files.length,
    directoryCount: tree.directories.length,
    sourceBytes: tree.files.reduce((sum, file) => sum + file.bytes, 0),
  };
}
