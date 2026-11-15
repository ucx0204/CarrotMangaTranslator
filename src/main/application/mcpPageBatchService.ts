import { McpPageBatchPreparation } from "./mcpPageBatchPreparation";
import { packMcpSnapshot } from "./mcpSnapshotPayload";
import { randomUUID } from "node:crypto";
import { createPageRevision } from "../../shared/pageRevision";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import {
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
  type McpTranslationBatchDirection,
  type McpTranslationBatchReceipt,
} from "../../shared/mcpTranslationBatch";
import type {
  BatchChange,
  BatchTarget,
  BatchPlan,
  BatchPorts,
  BatchPolicy,
  BatchTextRun,
  BatchEntry as Entry,
} from "./mcpPageBatchTypes";
import {
  runMcpPageBatch,
  describeBatchRun,
  batchAvailability,
} from "./mcpTranslationBatchRunner";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

const TTL = 30 * 60_000;
/** Memory-only review/history. Writes reuse the app page service; no model worker,
 * secret, file, or second library store is introduced. */
export class McpPageBatchService<
  I extends BatchTarget,
  C extends BatchChange,
  R,
  V,
  P extends BatchPlan<C> = BatchPlan<C>,
> {
  private readonly entries = new Map<string, Entry<I, C, P>>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly preparation = new McpPageBatchPreparation();
  private stopped = false;
  constructor(
    private readonly ports: BatchPorts<R>,
    private readonly policy: BatchPolicy<I, C, R, V, P>,
    private readonly now = Date.now,
    lifetime?: AbortSignal,
  ) {
    if (lifetime?.aborted) this.stop();
    else lifetime?.addEventListener("abort", () => this.stop(), { once: true });
  }
  stop() {
    this.stopped = true;
    for (const entry of this.entries.values()) entry.run?.controller.abort();
  }
  async close() {
    this.stop();
    await this.preparation.settle();
    await Promise.all(this.tasks);
    this.entries.clear();
  }
  private check(owner: string, guard: () => void) {
    guard();
    if (!owner || this.stopped)
      throw new McpEditError(
        "access_denied",
        "Batch editing session is unavailable.",
      );
  }
  private prune() {
    for (const [id, entry] of this.entries)
      if (!entry.busy && entry.expires <= this.now()) this.entries.delete(id);
  }
  private owned(owner: string, id: string, guard: () => void) {
    this.check(owner, guard);
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner)
      throw new McpEditError(
        "not_found",
        "Batch is missing, expired or owned by another connection. Inspect saved pages before creating a new plan.",
      );
    return entry;
  }
  private priorPreview(owner: string, input: I, signature: string) {
    const prior = [...this.entries.values()].find(
      (entry) =>
        entry.owner === owner && entry.input.requestId === input.requestId,
    );
    if (prior && prior.signature !== signature)
      throw new McpEditError(
        "invalid_edit",
        "Preview requestId belongs to different input.",
      );
    return prior;
  }
  async preview(
    owner: string,
    value: unknown,
    guard: () => void,
    signal?: AbortSignal,
  ) {
    this.check(owner, guard);
    const input = this.policy.parse(value);
    this.prune();
    const signature = JSON.stringify(input);
    const saved = await this.ports.read(input.chapterId);
    this.check(owner, guard);
    const prior = this.priorPreview(owner, input, signature);
    if (prior) return this.summary(prior, saved);
    const id = await this.preparation.run(
      JSON.stringify([owner, input.requestId]),
      signature,
      this.entries.size,
      [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0),
      () => this.prepare(owner, input, signature, saved, guard, signal),
    );
    return this.summary(this.owned(owner, id, guard), saved);
  }
  private async prepare(
    owner: string,
    input: I,
    signature: string,
    saved: McpContextSnapshot,
    guard: () => void,
    signal?: AbortSignal,
  ) {
    this.check(owner, guard);
    const plan = await this.policy.plan(saved, input, {
      owner,
      guard,
      signal,
    });
    this.check(owner, guard);
    this.prune();
    const size = packMcpSnapshot(plan);
    const bytes = size.totalBytes + Buffer.byteLength(signature);
    const occupied = [...this.entries.values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    if (
      size.metadataBytes + Buffer.byteLength(signature) > 4 * 1024 * 1024 ||
      bytes > 32 * 1024 * 1024
    )
      throw new McpEditError(
        "request_too_large",
        "This plan exceeds the per-plan metadata or snapshot limit. Split the explicit target list; nothing was saved. Waiting will not make this plan fit.",
      );
    if (this.entries.size >= 32 || occupied + bytes > 32 * 1024 * 1024)
      throw new McpEditError(
        "plan_capacity_full",
        "Bounded session history is full. Wait for retained plans to expire or be released before preparing another; nothing was saved.",
      );
    const entry: Entry<I, C, P> = {
      id: randomUUID(),
      owner,
      input,
      signature,
      plan,
      bytes,
      expires: this.now() + TTL,
      busy: false,
      applyStarted: false,
      receipts: new Map(),
    };
    this.entries.set(entry.id, entry);
    return entry.id;
  }
  async inspect(owner: string, value: unknown, guard: () => void) {
    const input = McpTranslationBatchGetSchema.parse(value);
    const entry = this.owned(owner, input.batchId, guard);
    const saved = await this.ports.read(entry.input.chapterId);
    this.owned(owner, input.batchId, guard);
    const changes = entry.plan.pages.flatMap((page) => page.changes);
    return {
      ...this.summary(entry, saved),
      offset: input.offset,
      limit: input.limit,
      nextOffset:
        input.offset + input.limit < changes.length
          ? input.offset + input.limit
          : null,
      changes: structuredClone(
        changes
          .slice(input.offset, input.offset + input.limit)
          .map(this.policy.project),
      ),
    };
  }
  /** Internal copied plan for bounded artifact inspection; never exposed as a transport object. */
  readOwnedPlan(owner: string, id: string, guard: () => void): P {
    return structuredClone(this.owned(owner, id, guard).plan);
  }
  private summary(entry: Entry<I, C, P>, saved?: McpContextSnapshot) {
    const changed = saved
      ? new Set(
          entry.plan.pages
            .filter((item) => {
              const page = saved.chapter.pages.find(
                (candidate) => candidate.id === item.pageId,
              );
              return (
                !page || createPageRevision(page) !== item.expectedRevision
              );
            })
            .map((page) => page.pageId),
        )
      : new Set<string>();
    const contextChanged = saved
      ? mcpContextRevision(saved) !== entry.input.contextRevision
      : false;
    const changes = entry.plan.pages.flatMap((page) => page.changes);
    return {
      batchId: entry.id,
      chapterId: entry.input.chapterId,
      contextRevision: entry.input.contextRevision,
      reason: entry.input.reason,
      expiresAt: entry.expires,
      ...describeBatchRun(entry.run),
      pages: entry.plan.pages.map(({ changes: _changes, ...page }) => ({
        ...page,
      })),
      totalChanges: changes.length,
      excludedChanges: changes.filter((change) => change.excludedReason).length,
      ...batchAvailability(entry, changed, contextChanged),
      warnings: [
        "availability_rechecked_under_page_lock",
        "render_each_changed_page_explicitly",
        "session_history_not_durable",
        ...(contextChanged ? ["saved_context_changed"] : []),
        ...[...changed].map((id) => `page_changed:${id}`),
        ...(changes.some((change) => change.excludedReason)
          ? [this.policy.exclusionWarning]
          : []),
      ],
    };
  }
  private replay(owner: string, requestId: string, signature: string) {
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner) continue;
      const receipt = entry.receipts.get(requestId);
      if (!receipt) continue;
      if (receipt.signature !== signature)
        throw new McpEditError(
          "invalid_edit",
          "Action requestId belongs to different input or direction.",
        );
      return {
        ...receipt.value,
        status: "already_started" as const,
        historical: true,
      };
    }
    return undefined;
  }
  start(
    owner: string,
    value: unknown,
    direction: McpTranslationBatchDirection,
    guard: () => void,
  ) {
    const input = McpTranslationBatchActionSchema.parse(value);
    const entry = this.owned(owner, input.batchId, guard);
    const signature = JSON.stringify({ ...input, direction });
    const prior = this.replay(owner, input.requestId, signature);
    if (prior) return prior;
    if (entry.busy)
      throw new McpEditError(
        "editor_busy",
        "Batch is running; wait for it to settle and inspect it before retrying.",
      );
    if (entry.receipts.size >= 32)
      throw new McpEditError(
        "action_history_full",
        "This batch has reached its action history limit. Inspect saved pages before planning remaining changes; waiting will not restore this batch's action capacity.",
      );
    const required = { apply: "pending", undo: "applied", redo: "undone" }[
      direction
    ];
    if (
      (direction === "apply" && entry.applyStarted) ||
      !entry.plan.pages.some((page) => page.state === required)
    )
      throw new McpEditError(
        "invalid_edit",
        "No eligible pages for this action. Replan unprocessed pages after partial failure; never force stale changes.",
      );
    const run: BatchTextRun = {
      requestId: input.requestId,
      direction,
      controller: new AbortController(),
      status: "running",
    };
    const receipt: McpTranslationBatchReceipt = {
      ...input,
      direction,
      status: "accepted",
      historical: false,
      note: `Accepted, NOT completed. Poll ${this.policy.inspectTool}. Cancellation does not roll back committed pages; use explicit undo.`,
    };
    entry.receipts.set(input.requestId, { signature, value: receipt });
    entry.run = run;
    entry.busy = true;
    if (direction === "apply") entry.applyStarted = true;
    const task = this.execute(entry, run, guard);
    entry.done = task;
    this.tasks.add(task);
    void task.finally(() => {
      this.tasks.delete(task);
    });
    return { ...receipt };
  }
  /** Internal completion handle for an already admitted owned action, never a transport bypass. */
  async waitForAction(
    owner: string,
    id: string,
    requestId: string,
    signal: AbortSignal,
  ) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.run?.requestId !== requestId)
      throw new McpEditError(
        "not_found",
        "Owned active batch action not found.",
      );
    const run = entry.run;
    const cancel = () => {
      if (entry.busy && entry.run === run) run.controller.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      await entry.done;
      return this.summary(entry);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  /** Release only a workflow-owned completed child plan after its native save/receipt.
   * User-created plans are not passed here and retain their normal undo lifetime. */
  releaseCompletedAction(owner: string, id: string, requestId: string) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.owner !== owner ||
      entry.busy ||
      entry.run?.requestId !== requestId ||
      entry.run.status !== "completed"
    )
      throw new McpEditError(
        "editor_busy",
        "Only an owned completed child action may be released.",
      );
    this.entries.delete(id);
  }
  private async execute(
    entry: Entry<I, C, P>,
    run: BatchTextRun,
    guard: () => void,
  ) {
    try {
      await runMcpPageBatch(
        entry.plan,
        entry.input,
        run,
        this.ports.commit,
        () => {
          this.check(entry.owner, guard);
          run.controller.signal.throwIfAborted();
          if (entry.expires <= this.now())
            throw new McpEditError(
              "not_found",
              "Batch history expired before the next commit.",
            );
        },
        () => {
          entry.expires = this.now() + TTL;
        },
        this.policy.request,
      );
      if (run.failure) this.ports.reportError(run.failure);
    } catch (error) {
      // Preserve the cause in session state even if the diagnostic sink itself fails.
      run.failure = run.failure
        ? new AggregateError([run.failure, error])
        : error;
      if (run.status === "running") run.status = "failed";
    } finally {
      entry.busy = false;
      entry.expires = this.now() + TTL;
    }
  }
  cancel(owner: string, value: unknown, guard: () => void) {
    const input = McpTranslationBatchActionSchema.parse(value);
    const entry = this.owned(owner, input.batchId, guard);
    if (entry.run?.requestId !== input.requestId)
      throw new McpEditError(
        "invalid_edit",
        "Cancel the currently inspected action requestId, not an older action.",
      );
    if (entry.busy) entry.run.controller.abort();
    return this.summary(entry);
  }
}
