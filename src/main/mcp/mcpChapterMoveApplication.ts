import { hashStableValue } from "../../shared/blockFingerprint";
import {
  libraryStructureResource,
  pageContentResource,
} from "../../shared/appActivityTypes";
import type {
  McpChapterMoveApply,
  McpChapterMoveIntent,
} from "../../shared/mcpChapterMove";
import type { McpChapterDeletionRecovery } from "../../shared/mcpChapterDeletion";
import {
  chapterMoveApplied,
  chapterMoveReceipt,
  chapterMoveSnapshot,
  priorChapterMoveAction,
  type ChapterMoveRecord,
} from "../application/mcpChapterMoveState";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  withLibraryRead,
  withLibraryMutation,
  withLibraryContentEdit,
} from "../library/lock";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import { logError } from "../logger";
import type { ChapterDeletionEditor } from "./mcpChapterDeletionApplication";
import { verifyChapterDeletionFiles } from "./mcpChapterDeletionFiles";
import { prepareChapterMove } from "./mcpChapterMovePreparation";
import { readChapterMoveState } from "./mcpChapterMoveSnapshot";
import { stageChapterMove } from "./mcpChapterMoveFiles";
import { McpChapterMoveRepository } from "./mcpChapterMoveRepository";

/** Two existing works, one closed chapter, one native transaction; never a second library. */
export class McpChapterMoveApplication {
  constructor(
    private readonly repository: McpChapterMoveRepository,
    private readonly editing?: ChapterDeletionEditor,
  ) {}
  preview(intent: McpChapterMoveIntent, guard: () => void) {
    return withLibraryRead(async () => {
      const plan = await prepareChapterMove(intent, guard);
      await this.verify(intent, plan.state.snapshot, guard);
      return plan.review;
    });
  }
  async apply(owner: string, input: McpChapterMoveApply, guard: () => void) {
    guard();
    const previous = await withLibraryRead(() =>
      this.repository.find(owner, input),
    );
    guard();
    if (previous)
      return chapterMoveReceipt(previous, input.requestId, "move", true);
    const receipt = await this.mutate(input.intent, async () => {
      const prior = await this.repository.find(owner, input);
      guard();
      if (prior)
        return chapterMoveReceipt(prior, input.requestId, "move", true);
      const plan = await prepareChapterMove(input.intent, guard);
      if (
        plan.review.snapshot !== input.snapshot ||
        plan.review.planFingerprint !== input.planFingerprint
      )
        throw new McpEditError(
          "revision_conflict",
          "Work, chapter, destination or reviewed mappings changed; review again.",
        );
      if (!plan.review.eligible)
        throw new McpEditError(
          "invalid_edit",
          "Unresolved references prevent movement. Review destination context and supply explicit mappings; catalogs are not merged automatically.",
        );
      await this.assertClosed(input.intent, guard);
      const saved = await runLibraryTransaction(
        "mcp-move-chapter",
        async (transaction) => {
          const { record, archive } = await this.repository.publish(
            transaction,
            owner,
            input,
            plan,
            guard,
          );
          await stageChapterMove(
            transaction,
            this.repository.storage,
            record,
            true,
            guard,
            archive,
          );
          transaction.beforePublish(async () => {
            await this.verify(input.intent, input.snapshot, guard);
            await this.assertClosed(input.intent, guard);
            this.repository.assertLive(record);
          });
          return record;
        },
        undefined,
        guard,
      );
      return chapterMoveReceipt(saved, input.requestId, "move");
    });
    this.announce(receipt);
    return receipt;
  }
  inspect(owner: string, id: string, guard: () => void) {
    return withLibraryRead(async () => {
      guard();
      const record = await this.repository.load(owner, id);
      const state = await readChapterMoveState(record.input.intent, guard);
      await verifyChapterDeletionFiles(this.repository.storage, record, guard);
      await this.verify(record.input.intent, state.snapshot, guard);
      this.repository.assertLive(record);
      const moved = chapterMoveApplied(record);
      const available =
        state.snapshot === expectedMoveSnapshot(record, moved) &&
        record.actions.length < 32;
      return {
        id,
        intent: record.input.intent,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        snapshot: state.snapshot,
        moved,
        actionsUsed: record.actions.length,
        canUndo: available && moved,
        canRedo: available && !moved,
        warnings: [
          "availability_rechecked_at_publication",
          "target_must_be_closed_and_unlinked",
          ...(!available
            ? ["later_changes_or_action_limit_prevent_exact_recovery"]
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
    guard();
    const original = await withLibraryRead(() =>
      this.repository.load(owner, input.id),
    );
    guard();
    if (priorChapterMoveAction(original, input, direction))
      return chapterMoveReceipt(original, input.requestId, direction, true);
    const receipt = await this.mutate(original.input.intent, async () => {
      const record = await this.repository.load(owner, input.id);
      guard();
      if (priorChapterMoveAction(record, input, direction))
        return chapterMoveReceipt(record, input.requestId, direction, true);
      if (hashStableValue(record) !== hashStableValue(original))
        throw new McpEditError(
          "revision_conflict",
          "Movement recovery changed during admission.",
        );
      assertRecovery(record, input, direction);
      const intent = record.input.intent;
      await this.verify(intent, input.snapshot, guard);
      await this.assertClosed(intent, guard);
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
        "mcp-recover-chapter-move",
        async (transaction) => {
          await stageChapterMove(
            transaction,
            this.repository.storage,
            record,
            direction === "redo",
            guard,
          );
          await this.repository.save(transaction, next);
          transaction.beforePublish(async () => {
            await this.verify(intent, input.snapshot, guard);
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
                "Movement record changed before publication.",
              );
            await this.assertClosed(intent, guard);
            this.repository.assertLive(record);
          });
        },
        undefined,
        guard,
      );
      return chapterMoveReceipt(next, input.requestId, direction);
    });
    this.announce(receipt);
    return receipt;
  }
  private async verify(
    intent: McpChapterMoveIntent,
    snapshot: string,
    guard: () => void,
  ) {
    if ((await readChapterMoveState(intent, guard)).snapshot !== snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Later library or context changes prevent exact movement; no forced overwrite.",
      );
    guard();
  }
  private async assertClosed(intent: McpChapterMoveIntent, guard: () => void) {
    guard();
    if (!this.editing)
      throw new McpEditError(
        "editor_busy",
        "Trusted editor probe is unavailable.",
      );
    await this.editing.assertChapterClosed(intent.chapterId);
    guard();
  }
  private mutate<T>(intent: McpChapterMoveIntent, action: () => Promise<T>) {
    return withLibraryContentEdit(
      [
        libraryStructureResource("work", intent.workId),
        libraryStructureResource("work", intent.destinationWorkId),
        libraryStructureResource("chapter", intent.chapterId),
        pageContentResource(intent.chapterId, "**"),
        { kind: "work-context", scope: intent.workId, access: "write" },
        {
          kind: "work-context",
          scope: intent.destinationWorkId,
          access: "write",
        },
      ],
      () => withLibraryMutation(action),
    );
  }
  private announce(receipt: ReturnType<typeof chapterMoveReceipt>) {
    if (receipt.historical) return;
    for (const workId of [receipt.workId, receipt.destinationWorkId]) {
      try {
        this.editing?.notifyLibraryChanged?.({
          workId,
          chapterId: receipt.chapterId,
        });
      } catch (error) {
        // error-policy-allow: native move committed; keep the durable result and report notification failure.
        if (!receipt.warnings.includes("notification_failed_after_commit"))
          receipt.warnings.push("notification_failed_after_commit");
        logError("Chapter move saved; renderer notification failed", error);
      }
    }
  }
}
function expectedMoveSnapshot(record: ChapterMoveRecord, moved: boolean) {
  return chapterMoveSnapshot(
    record.input.intent,
    moved ? record.after : record.before,
    moved ? record.afterTree : record.tree,
    moved,
  );
}
function assertRecovery(
  record: ChapterMoveRecord,
  input: McpChapterDeletionRecovery,
  direction: "undo" | "redo",
) {
  const moved = chapterMoveApplied(record);
  if (record.actions.length >= 32 || moved !== (direction === "undo"))
    throw new McpEditError(
      "invalid_edit",
      "Requested movement recovery is unavailable.",
    );
  if (input.snapshot !== expectedMoveSnapshot(record, moved))
    throw new McpEditError(
      "revision_conflict",
      "Recovery requires the current movement snapshot.",
    );
}
