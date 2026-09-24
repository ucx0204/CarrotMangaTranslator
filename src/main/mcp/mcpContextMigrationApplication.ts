import { captureWorkContextMetadata } from "../libraryStore/workContextMigration";
import type {
  McpContextMigrationApply,
  McpContextMigrationRecovery,
} from "../../shared/mcpContextMigration";
import type {
  ContextMigrationDelta,
  RetainedContextMigration,
} from "../../shared/mcpContextMigrationState";
import type { McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import {
  contextMigrationSnapshot,
  createMcpContextMigrationDelta,
  prepareMcpContextMigration,
  contextMigrationDeltaCounts,
} from "../application/mcpContextMigrationPolicy";
import {
  checkRecoveryState,
  recoveryTarget,
  contextMigrationPresenceMismatch,
} from "./mcpContextMigrationRecoveryEvidence";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import { withLibraryRead } from "../library/lock";
import { readWorkContextReferencesUnlocked } from "../library/libraryContextEditingFacade";
import { commitWorkContextMigration } from "../library/libraryContextMigrationFacade";
import { runContextMigration } from "./mcpContextMigrationScope";
import {
  McpContextMigrationRepository,
  contextMigrationSignature,
  contextMigrationState,
  priorContextMigrationAction,
  contextMigrationReceipt,
} from "./mcpContextMigrationRepository";

type Graph = McpContextReferenceSnapshot;
type Receipt = ReturnType<typeof contextMigrationReceipt>;
type Editing = Parameters<typeof runContextMigration>[0]["editing"];
type Intent = { chapterId: string; requestId: string };
type IntentOperation = RetainedContextMigration["operation"];
type Preparation = (
  graph: Graph,
  now: string,
  guard: () => void,
) => Pick<
  RetainedContextMigration,
  "delta" | "beforeSnapshot" | "afterSnapshot"
>;

/** Uses native ownership and one atomic context/reference/receipt publication. */
export class McpContextMigrationApplication {
  constructor(
    private readonly repository: McpContextMigrationRepository,
    private readonly app: InpaintingJobContext,
    private readonly editing: Editing,
    private readonly lifetime: AbortSignal,
  ) {}

  apply(owner: string, input: McpContextMigrationApply, guard: () => void) {
    return this.applyIntent(owner, input, guard, (graph, now, check) =>
      createMcpContextMigrationDelta(
        graph,
        prepareMcpContextMigration(graph, input, check),
        now,
        check,
      ),
    );
  }

  /** Native-only policy injection; no tool accepts callbacks, deltas or raw snapshots. */
  async applyIntent(
    owner: string,
    input: Intent,
    guard: () => void,
    prepare: Preparation,
    operation?: IntentOperation,
  ) {
    const replay = await this.replayIntent(owner, input, guard, operation);
    if (replay) return replay;
    const signature = contextMigrationSignature(
      "apply",
      operation ? { operation, input } : input,
    );
    const graph = await this.read(input.chapterId, guard);
    const change = prepare(graph, this.timestamp(), guard);
    return this.execute(graph, change.delta, guard, (check) =>
      commitWorkContextMigration<Receipt>(
        input.chapterId,
        (current, present, memoryPresence) =>
          this.prepareApply(
            owner,
            input,
            current,
            present,
            memoryPresence,
            check,
            prepare,
            signature,
            operation,
          ),
        check,
      ),
    );
  }

  /** Resolve durable replay before requiring an ephemeral uploaded input again. */
  async replayIntent(
    owner: string,
    input: Intent,
    guard: () => void,
    operation?: IntentOperation,
  ) {
    guard();
    this.lifetime.throwIfAborted();
    const signature = contextMigrationSignature(
      "apply",
      operation ? { operation, input } : input,
    );
    const prior = await withLibraryRead(() =>
      this.repository.find(owner, input.requestId, signature),
    );
    guard();
    this.lifetime.throwIfAborted();
    return prior
      ? contextMigrationReceipt(
          prior,
          "apply",
          input.requestId,
          prior.afterSnapshot,
          true,
        )
      : undefined;
  }

  private async prepareApply(
    owner: string,
    input: Intent,
    current: Graph,
    guideBeforePresent: boolean,
    memoryPresence: ReadonlyMap<string, boolean>,
    guard: () => void,
    prepare: Preparation,
    signature: string,
    operation?: IntentOperation,
  ) {
    const prior = await this.repository.find(owner, input.requestId, signature);
    if (prior)
      return {
        skip: true as const,
        result: contextMigrationReceipt(
          prior,
          "apply",
          input.requestId,
          prior.afterSnapshot,
          true,
        ),
      };
    const next = prepare(current, this.timestamp(), guard);
    for (const memory of next.delta.memories) {
      const present = memoryPresence.get(memory.chapterId);
      if (present === undefined)
        throw new Error("Missing native memory file evidence.");
      memory.beforePresent = present;
    }
    const record = this.repository.create({
      owner,
      workId: current.workId,
      anchorChapterId: input.chapterId,
      requestId: input.requestId,
      signature,
      guideBeforePresent,
      delta: next.delta,
      beforeSnapshot: next.beforeSnapshot,
      afterSnapshot: next.afterSnapshot,
      ...(operation ? { operation } : {}),
    });
    return {
      skip: false as const,
      result: contextMigrationReceipt(
        record,
        "apply",
        input.requestId,
        record.afterSnapshot,
      ),
      delta: record.delta,
      direction: "apply" as const,
      guideBeforePresent,
      verify: (latest: Graph) => {
        prepare(latest, this.timestamp(), guard);
      },
      receipt: (transaction: LibraryTransaction) =>
        this.repository.publish(transaction, record),
    };
  }

  async recover(
    owner: string,
    input: McpContextMigrationRecovery,
    direction: "undo" | "redo",
    guard: () => void,
  ) {
    guard();
    this.lifetime.throwIfAborted();
    const signature = contextMigrationSignature(direction, input);
    const record = await withLibraryRead(() =>
      this.repository.load(owner, input.id),
    );
    guard();
    const prior = priorContextMigrationAction(
      record,
      input.requestId,
      signature,
    );
    if (prior)
      return contextMigrationReceipt(
        record,
        direction,
        input.requestId,
        prior.referenceSnapshot,
        true,
      );
    const graph = await this.read(record.anchorChapterId, guard);
    checkRecoveryState(
      graph,
      record,
      input.referenceSnapshot,
      direction,
      guard,
    );
    return this.execute(graph, record.delta, guard, (check) =>
      commitWorkContextMigration<Receipt>(
        record.anchorChapterId,
        (current, present, memoryPresence) =>
          this.prepareRecovery(
            owner,
            input,
            direction,
            current,
            present,
            memoryPresence,
            check,
          ),
        check,
      ),
    );
  }

  private async prepareRecovery(
    owner: string,
    input: McpContextMigrationRecovery,
    direction: "undo" | "redo",
    current: Graph,
    guidePresent: boolean,
    memoryPresence: ReadonlyMap<string, boolean>,
    guard: () => void,
  ) {
    const signature = contextMigrationSignature(direction, input);
    const fresh = await this.repository.load(owner, input.id);
    const prior = priorContextMigrationAction(
      fresh,
      input.requestId,
      signature,
    );
    if (prior)
      return {
        skip: true as const,
        result: contextMigrationReceipt(
          fresh,
          direction,
          input.requestId,
          prior.referenceSnapshot,
          true,
        ),
      };
    const snapshot = recoveryTarget(
      current,
      fresh,
      input.referenceSnapshot,
      direction,
      guidePresent,
      memoryPresence,
      guard,
    );
    const updated = {
      ...fresh,
      actions: [
        ...fresh.actions,
        {
          requestId: input.requestId,
          signature,
          direction,
          referenceSnapshot: snapshot,
        },
      ],
    };
    return {
      skip: false as const,
      result: contextMigrationReceipt(
        fresh,
        direction,
        input.requestId,
        snapshot,
      ),
      delta: fresh.delta,
      direction,
      guideBeforePresent: fresh.guideBeforePresent,
      verify: (latest: Graph) => {
        checkRecoveryState(
          latest,
          fresh,
          input.referenceSnapshot,
          direction,
          guard,
        );
      },
      receipt: (transaction: LibraryTransaction) =>
        this.repository.save(transaction, updated),
    };
  }
  async inspect(owner: string, id: string, guard: () => void) {
    guard();
    this.lifetime.throwIfAborted();
    return withLibraryRead(async () => {
      const record = await this.repository.load(owner, id);
      const files = await captureWorkContextMetadata(record.workId, guard);
      const graph = await readWorkContextReferencesUnlocked(
        record.anchorChapterId,
        guard,
      );
      const referenceSnapshot = contextMigrationSnapshot(
        graph,
        record.anchorChapterId,
        guard,
      ).snapshot;
      await files.verify();
      const state = contextMigrationState(record);
      const mismatch = contextMigrationPresenceMismatch(
        record,
        files.guidePresent,
        files.memoryPresence,
        state.applied,
      );
      const matches =
        referenceSnapshot === state.expected &&
        graph.workId === record.workId &&
        !mismatch;
      guard();
      this.lifetime.throwIfAborted();
      return {
        id,
        workId: record.workId,
        anchorChapterId: record.anchorChapterId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        referenceSnapshot,
        changes: contextMigrationDeltaCounts(record.delta),
        actionsUsed: record.actions.length,
        canUndo: matches && state.room && state.changed && state.applied,
        canRedo: matches && state.room && state.changed && !state.applied,
        warnings: [
          "availability_rechecked_at_native_publication",
          "metadata_only_no_image_or_model_processing",
          ...(!matches ? ["work_changed_after_migration"] : []),
          ...(mismatch ? [mismatch] : []),
          ...(!state.room ? ["action_history_full"] : []),
        ],
      };
    });
  }

  private async read(chapterId: string, guard: () => void) {
    guard();
    this.lifetime.throwIfAborted();
    const graph = await withLibraryRead(() =>
      readWorkContextReferencesUnlocked(chapterId, guard),
    );
    guard();
    return graph;
  }

  private timestamp() {
    return new Date(this.repository.storage.now()).toISOString();
  }

  private execute(
    graph: Graph,
    delta: ContextMigrationDelta,
    guard: () => void,
    run: (check: () => void) => Promise<Receipt>,
  ) {
    return runContextMigration({
      app: this.app,
      editing: this.editing,
      lifetime: this.lifetime,
      graph,
      delta,
      guard,
      run,
    });
  }
}
