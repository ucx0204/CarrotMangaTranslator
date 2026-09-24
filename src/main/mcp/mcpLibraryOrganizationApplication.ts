import { logError } from "../logger";
import type { McpLibraryChangedEvent } from "../../shared/mcpEditingTypes";
import { hashStableValue } from "../../shared/blockFingerprint";
import { libraryStructureResource } from "../../shared/appActivityTypes";
import type {
  McpLibraryOrganizationIntent,
  McpLibraryOrganizationApply,
  McpLibraryOrganizationRecovery,
} from "../../shared/mcpLibraryOrganization";
import {
  libraryChangeApplied,
  libraryChangeReceipt,
  priorLibraryChangeAction,
} from "../application/mcpLibraryOrganizationState";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  readLibraryOrganizationUnlocked,
  prepareLibraryOrganizationUnlocked,
  commitLibraryOrganizationUnlocked,
  libraryOrganizationSnapshot,
  libraryOrganizationFields,
  restoreLibraryOrganizationFields,
} from "../libraryStore/libraryOrganization";
import {
  withLibraryRead,
  withLibraryMutation,
  withLibraryContentEdit,
} from "../library/lock";
import { McpLibraryOrganizationRepository } from "./mcpLibraryOrganizationRepository";

type State = Awaited<ReturnType<typeof readLibraryOrganizationUnlocked>>;
type Intent = McpLibraryOrganizationIntent;
type Record = Awaited<ReturnType<McpLibraryOrganizationRepository["load"]>>;

/** This native adapter composes existing library ownership, transactions and retention. */
export class McpLibraryOrganizationApplication {
  constructor(
    private readonly repository: McpLibraryOrganizationRepository,
    private readonly notifyChanged?: (event: McpLibraryChangedEvent) => void,
  ) {}
  preview(intent: Intent, guard: () => void) {
    guard();
    return withLibraryRead(
      async () => (await this.prepare(intent, guard)).review,
    );
  }
  async apply(
    owner: string,
    input: McpLibraryOrganizationApply,
    guard: () => void,
  ) {
    guard();
    const previous = await withLibraryRead(() =>
      this.repository.find(owner, input),
    );
    guard();
    if (previous)
      return libraryChangeReceipt(previous, input.requestId, "apply", true);
    const receipt = await this.mutate(input.intent, async () => {
      guard();
      const prior = await this.repository.find(owner, input);
      guard();
      if (prior)
        return libraryChangeReceipt(prior, input.requestId, "apply", true);
      const { change, review } = await this.prepare(input.intent, guard);
      if (
        review.snapshot !== input.snapshot ||
        review.planFingerprint !== input.planFingerprint
      )
        throw new McpEditError(
          "revision_conflict",
          "Library metadata or reviewed intent changed; prepare a new review.",
        );
      if (!review.changed) change.after = change.before;
      const record = this.repository.create(
        owner,
        input,
        retainedState(change.before),
        retainedState(change.after),
      );
      await commitLibraryOrganizationUnlocked(change, {
        guard,
        stage: (transaction) => this.repository.publish(transaction, record),
      });
      return libraryChangeReceipt(record, input.requestId, "apply");
    });
    this.announce(input.intent, receipt);
    return receipt;
  }
  inspect(owner: string, id: string, guard: () => void) {
    guard();
    return withLibraryRead(async () => {
      const record = await this.repository.load(owner, id);
      const current = await readLibraryOrganizationUnlocked(
        record.input.intent,
      );
      this.repository.assertLive(record);
      guard();
      const snapshot = libraryOrganizationSnapshot(current);
      const applied = libraryChangeApplied(record);
      const changed = record.before.snapshot !== record.after.snapshot;
      const matches =
        snapshot === (applied ? record.after.snapshot : record.before.snapshot);
      if (matches)
        verifiedRestoration(record, current, applied ? "undo" : "redo");
      const room = record.actions.length < 32;
      return {
        id,
        intent: record.input.intent,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        snapshot,
        changed,
        applied,
        actionsUsed: record.actions.length,
        canUndo: matches && changed && room && applied,
        canRedo: matches && changed && room && !applied,
        warnings: [
          "availability_rechecked_at_native_publication",
          ...(!matches ? ["library_changed_after_record"] : []),
          ...(!room ? ["action_history_full"] : []),
        ],
      };
    });
  }
  async recover(
    owner: string,
    input: McpLibraryOrganizationRecovery,
    direction: "undo" | "redo",
    guard: () => void,
  ) {
    guard();
    const original = await withLibraryRead(() =>
      this.repository.load(owner, input.id),
    );
    guard();
    if (priorLibraryChangeAction(original, input, direction))
      return libraryChangeReceipt(original, input.requestId, direction, true);
    const receipt = await this.mutate(original.input.intent, async () => {
      guard();
      const record = await this.repository.load(owner, input.id);
      if (record.signature !== original.signature)
        throw new McpEditError(
          "revision_conflict",
          "Library recovery identity changed.",
        );
      if (priorLibraryChangeAction(record, input, direction))
        return libraryChangeReceipt(record, input.requestId, direction, true);
      const before = await readLibraryOrganizationUnlocked(record.input.intent);
      guard();
      this.assertRecovery(record, before, input, direction);
      const after = verifiedRestoration(record, before, direction);
      const target = direction === "undo" ? record.before : record.after;
      const next = {
        ...record,
        actions: [
          ...record.actions,
          {
            requestId: input.requestId,
            signature: hashStableValue({ direction, input }),
            direction,
            snapshot: target.snapshot,
          },
        ],
      };
      await commitLibraryOrganizationUnlocked(
        { before, after },
        {
          guard,
          stage: (transaction) => this.repository.save(transaction, next),
        },
      );
      return libraryChangeReceipt(record, input.requestId, direction);
    });
    this.announce(original.input.intent, receipt);
    return receipt;
  }
  private assertRecovery(
    record: Record,
    current: State,
    input: McpLibraryOrganizationRecovery,
    direction: "undo" | "redo",
  ) {
    const applied = libraryChangeApplied(record);
    if (
      record.actions.length >= 32 ||
      record.before.snapshot === record.after.snapshot ||
      applied !== (direction === "undo")
    )
      throw new McpEditError(
        "invalid_edit",
        "Requested metadata recovery is unavailable in the current action state.",
      );
    const snapshot = libraryOrganizationSnapshot(current);
    const expected = applied ? record.after.snapshot : record.before.snapshot;
    if (snapshot !== input.snapshot || snapshot !== expected)
      throw new McpEditError(
        "revision_conflict",
        "Later library edits conflict with exact recovery; no forced overwrite.",
      );
  }
  private async prepare(intent: Intent, guard: () => void) {
    guard();
    const change = await prepareLibraryOrganizationUnlocked(intent);
    assertCompleteOrder(intent, change.before);
    const snapshot = libraryOrganizationSnapshot(change.before);
    const before = visibleChange(intent, change.before);
    const after = visibleChange(intent, change.after);
    const changed = hashStableValue(before) !== hashStableValue(after);
    const current = await readLibraryOrganizationUnlocked(intent);
    if (libraryOrganizationSnapshot(current) !== snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Library changed while preparing the review.",
      );
    guard();
    return {
      change,
      review: {
        intent,
        snapshot,
        planFingerprint: hashStableValue({ intent, snapshot, before, after }),
        changed,
        before,
        after,
        warnings: [
          "metadata_only_no_images_models_or_file_moves",
          "chapter_titles_use_existing_native_unique_name_policy",
          intent.kind === "reorder-pages"
            ? "page_order_reconciles_memory_indexes_names_and_duplicate_or_orphan_rows_as_reviewed_no_summary_generation"
            : "chapter_order_can_change_future_context_order_but_does_not_rewrite_saved_memory",
        ],
      },
    };
  }
  private announce(
    intent: Intent,
    receipt: ReturnType<typeof libraryChangeReceipt>,
  ) {
    if (receipt.historical || receipt.status !== "saved") return;
    try {
      this.notifyChanged?.({
        workId: intent.workId,
        ...("chapterId" in intent ? { chapterId: intent.chapterId } : {}),
      });
    } catch (error) {
      // error-policy-allow: the native transaction committed; preserve its receipt and report notification failure.
      receipt.warnings.push("notification_failed_after_commit");
      logError("Library metadata saved; renderer notification failed", error);
    }
  }
  private mutate<T>(intent: Intent, run: () => Promise<T>): Promise<T> {
    return withLibraryContentEdit(
      [
        libraryStructureResource("work", intent.workId),
        ...("chapterId" in intent
          ? [libraryStructureResource("chapter", intent.chapterId)]
          : []),
        ...(intent.kind === "reorder-pages"
          ? [
              {
                kind: "work-context" as const,
                scope: intent.workId,
                access: "write" as const,
              },
            ]
          : []),
      ],
      () => withLibraryMutation(run),
    );
  }
}
function retainedState(state: State) {
  return {
    fields: libraryOrganizationFields(state),
    snapshot: libraryOrganizationSnapshot(state),
  };
}
function visibleChange(intent: Intent, state: State) {
  if (intent.kind === "reorder-pages")
    return {
      title: null,
      chapterIds: [],
      pageIds: state.chapter?.pageOrder ?? [],
      memory: {
        present: state.pageOrdering?.memory !== null,
        rows: (state.pageOrdering?.memory?.pages ?? []).map(
          ({ pageId, pageIndex, pageName }) => ({
            pageId,
            pageIndex,
            pageName,
          }),
        ),
      },
    };
  return intent.kind === "reorder-chapters"
    ? { title: null, chapterIds: state.work.chapterOrder }
    : {
        title:
          intent.kind === "rename-chapter"
            ? (state.chapter?.title ?? null)
            : state.work.title,
        chapterIds: [],
      };
}
function assertCompleteOrder(intent: Intent, state: State) {
  if (intent.kind !== "reorder-chapters" && intent.kind !== "reorder-pages")
    return;
  const stored =
    intent.kind === "reorder-pages"
      ? (state.chapter?.pageOrder ?? [])
      : state.work.chapterOrder;
  const requested =
    intent.kind === "reorder-pages" ? intent.pageIds : intent.chapterIds;
  const current = new Set(stored);
  if (
    intent.kind === "reorder-pages" &&
    state.chapter?.pages.length !== current.size
  )
    throw new McpEditError(
      "invalid_edit",
      "Saved page inventory and order disagree; review the chapter before reordering.",
    );
  if (
    requested.length !== current.size ||
    requested.some((id) => !current.has(id))
  )
    throw new McpEditError(
      "invalid_edit",
      "MCP ordering requires every current ID exactly once; it never adds, drops or moves pages or chapters.",
    );
}
function verifiedRestoration(
  record: Record,
  current: State,
  direction: "undo" | "redo",
) {
  const target = direction === "undo" ? record.before : record.after;
  const expected = direction === "undo" ? record.after : record.before;
  const restored = restoreLibraryOrganizationFields(current, target.fields);
  const roundtrip = restoreLibraryOrganizationFields(restored, expected.fields);
  if (
    libraryOrganizationSnapshot(restored) !== target.snapshot ||
    libraryOrganizationSnapshot(roundtrip) !== expected.snapshot
  )
    throw new McpEditError(
      "invalid_edit",
      "Stored metadata cannot restore the exact reviewed state in both directions.",
    );
  return restored;
}
