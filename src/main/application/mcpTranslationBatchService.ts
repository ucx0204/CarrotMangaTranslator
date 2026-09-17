import { randomUUID } from "node:crypto";
import { createPageRevision } from "../../shared/pageRevision";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import {
  McpTranslationBatchPreviewSchema, McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema, type McpTranslationBatchPreview,
  type McpTranslationBatchDirection, type McpTranslationBatchReceipt,
} from "../../shared/mcpTranslationBatch";
import { planMcpTranslationBatch, type BatchTextPlan } from "./mcpTranslationBatchPolicy";
import { runMcpTranslationBatch, type BatchTextCommit, type BatchTextRun } from "./mcpTranslationBatchRunner";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Entry = {
  id: string; owner: string; input: McpTranslationBatchPreview; signature: string;
  plan: BatchTextPlan; bytes: number; expires: number; busy: boolean; applyStarted: boolean;
  run?: BatchTextRun;
  receipts: Map<string, { signature: string; value: McpTranslationBatchReceipt }>;
};
type Ports = {
  read: (chapterId: string) => Promise<McpContextSnapshot>;
  commit: BatchTextCommit;
  reportError: (error: unknown) => void;
};
const TTL = 30 * 60_000;
/** Memory-only review/history. Writes reuse the app page service; no model worker,
 * secret, file, or second library store is introduced. */
export class McpTranslationBatchService {
  private readonly entries = new Map<string, Entry>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;
  constructor(private readonly ports: Ports, private readonly now = Date.now, lifetime?: AbortSignal) {
    if (lifetime?.aborted) this.stop();
    else lifetime?.addEventListener("abort", () => this.stop(), { once: true });
  }
  stop() {
    this.stopped = true;
    for (const entry of this.entries.values()) entry.run?.controller.abort();
  }
  async close() {
    this.stop();
    await Promise.all(this.tasks);
    this.entries.clear();
  }
  private check(owner: string, guard: () => void) {
    guard();
    if (!owner || this.stopped) throw new McpEditError("access_denied", "Batch editing session is unavailable.");
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
      throw new McpEditError("not_found", "Batch is missing, expired or owned by another connection. Inspect saved pages before creating a new plan.");
    return entry;
  }
  private priorPreview(owner: string, input: McpTranslationBatchPreview, signature: string) {
    const prior = [...this.entries.values()].find((entry) => entry.owner === owner && entry.input.requestId === input.requestId);
    if (prior && prior.signature !== signature)
      throw new McpEditError("invalid_edit", "Preview requestId belongs to different input.");
    return prior;
  }
  async preview(owner: string, value: unknown, guard: () => void) {
    this.check(owner, guard);
    const input = McpTranslationBatchPreviewSchema.parse(value);
    this.prune();
    const signature = JSON.stringify(input);
    const saved = await this.ports.read(input.chapterId);
    this.check(owner, guard);
    const prior = this.priorPreview(owner, input, signature);
    if (prior) return this.summary(prior, saved);
    const plan = planMcpTranslationBatch(saved, input);
    const bytes = Buffer.byteLength(JSON.stringify(plan)) + Buffer.byteLength(signature);
    const occupied = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    if (this.entries.size >= 32 || bytes > 4 * 1024 * 1024 || occupied + bytes > 32 * 1024 * 1024)
      throw new McpEditError("editor_busy", "Bounded session history is full or this plan is too large. Split the explicit target list; nothing was saved.");
    const entry: Entry = { id: randomUUID(), owner, input, signature, plan, bytes,
      expires: this.now() + TTL, busy: false, applyStarted: false, receipts: new Map() };
    this.entries.set(entry.id, entry);
    return this.summary(entry, saved);
  }
  async inspect(owner: string, value: unknown, guard: () => void) {
    const input = McpTranslationBatchGetSchema.parse(value);
    const entry = this.owned(owner, input.batchId, guard);
    const saved = await this.ports.read(entry.input.chapterId);
    this.owned(owner, input.batchId, guard);
    const changes = entry.plan.pages.flatMap((page) => page.changes);
    return { ...this.summary(entry, saved), offset: input.offset, limit: input.limit,
      nextOffset: input.offset + input.limit < changes.length ? input.offset + input.limit : null,
      changes: structuredClone(changes.slice(input.offset, input.offset + input.limit)) };
  }
  private summary(entry: Entry, saved?: McpContextSnapshot) {
    const changed = saved ? new Set(entry.plan.pages.filter((item) => {
      const page = saved.chapter.pages.find((candidate) => candidate.id === item.pageId);
      return !page || createPageRevision(page) !== item.expectedRevision;
    }).map((page) => page.pageId)) : new Set<string>();
    const contextChanged = saved ? mcpContextRevision(saved) !== entry.input.contextRevision : false;
    const eligible = (state: string) => entry.plan.pages.some((page) => page.state === state && !changed.has(page.pageId));
    const changes = entry.plan.pages.flatMap((page) => page.changes);
    return {
      batchId: entry.id, chapterId: entry.input.chapterId, contextRevision: entry.input.contextRevision,
      reason: entry.input.reason, expiresAt: entry.expires,
      status: entry.run?.status ?? "proposed", direction: entry.run?.direction ?? null,
      activeRequestId: entry.run?.requestId ?? null,
      cancellationRequested: entry.run?.controller.signal.aborted ?? false,
      pages: entry.plan.pages.map(({ changes: _changes, ...page }) => ({ ...page })),
      totalChanges: changes.length, excludedChanges: changes.filter((change) => change.excludedReason).length,
      canApply: !entry.busy && !entry.applyStarted && !contextChanged && eligible("pending"),
      canUndo: !entry.busy && eligible("applied"),
      canRedo: !entry.busy && !contextChanged && eligible("undone"),
      warnings: ["availability_rechecked_under_page_lock", "render_each_changed_page_explicitly", "session_history_not_durable",
        ...(contextChanged ? ["saved_context_changed"] : []),
        ...[...changed].map((id) => `page_changed:${id}`),
        ...(changes.some((change) => change.excludedReason) ? ["generated_lettering_excluded"] : [])],
    };
  }
  private replay(owner: string, requestId: string, signature: string) {
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner) continue;
      const receipt = entry.receipts.get(requestId);
      if (!receipt) continue;
      if (receipt.signature !== signature)
        throw new McpEditError("invalid_edit", "Action requestId belongs to different input or direction.");
      return { ...receipt.value, status: "already_started" as const, historical: true };
    }
    return undefined;
  }
  start(owner: string, value: unknown, direction: McpTranslationBatchDirection, guard: () => void) {
    const input = McpTranslationBatchActionSchema.parse(value);
    const entry = this.owned(owner, input.batchId, guard);
    const signature = JSON.stringify({ ...input, direction });
    const prior = this.replay(owner, input.requestId, signature);
    if (prior) return prior;
    if (entry.busy || entry.receipts.size >= 32)
      throw new McpEditError("editor_busy", "Batch is running or its action history is full; inspect it first.");
    const required = { apply: "pending", undo: "applied", redo: "undone" }[direction];
    if ((direction === "apply" && entry.applyStarted) || !entry.plan.pages.some((page) => page.state === required))
      throw new McpEditError("invalid_edit", "No eligible pages for this action. Replan unprocessed pages after partial failure; never force stale changes.");
    const run: BatchTextRun = { requestId: input.requestId, direction, controller: new AbortController(), status: "running" };
    const receipt: McpTranslationBatchReceipt = { ...input, direction, status: "accepted", historical: false,
      note: "Accepted, NOT completed. Poll carrot_get_translation_batch. Cancellation does not roll back committed pages; use explicit undo." };
    entry.receipts.set(input.requestId, { signature, value: receipt });
    entry.run = run;
    entry.busy = true;
    if (direction === "apply") entry.applyStarted = true;
    const task = this.execute(entry, run, guard);
    this.tasks.add(task);
    void task.finally(() => { this.tasks.delete(task); });
    return { ...receipt };
  }
  private async execute(entry: Entry, run: BatchTextRun, guard: () => void) {
    try {
      await runMcpTranslationBatch(entry.plan, entry.input, run, this.ports.commit, () => {
        this.check(entry.owner, guard);
        run.controller.signal.throwIfAborted();
        if (entry.expires <= this.now()) throw new McpEditError("not_found", "Batch history expired before the next commit.");
      }, () => { entry.expires = this.now() + TTL; });
      if (run.failure) this.ports.reportError(run.failure);
    } catch (error) {
      // Preserve the cause in session state even if the diagnostic sink itself fails.
      run.failure = run.failure ? new AggregateError([run.failure, error]) : error;
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
      throw new McpEditError("invalid_edit", "Cancel the currently inspected action requestId, not an older action.");
    if (entry.busy) entry.run.controller.abort();
    return this.summary(entry);
  }
}
