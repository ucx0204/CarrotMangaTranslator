import { hashStableValue } from "../../shared/blockFingerprint";
import {
  mcpImportBatchOutputs,
  type McpImportBatchPrepare,
  type McpImportBatchRun,
} from "../../shared/mcpImportBatch";
import type { McpImportBatchPublish } from "../../shared/mcpImportPublication";
import { McpEditError } from "./mcpEditPolicy";
import type { McpOperationContext } from "./mcpOperationService";
import {
  importBatchReference,
  type McpImportBatchRecord,
  type McpImportBatchRow,
} from "./mcpImportBatchState";
import {
  checkpointImportBatch,
  executeImportBatch,
  retainedImportReceipt,
  type McpImportBatchActive,
  type McpImportBatchPorts,
} from "./mcpImportBatchRunner";

type Ports = McpImportBatchPorts & {
  publish: (
    owner: string,
    input: McpImportBatchPublish,
    context: McpOperationContext,
  ) => Promise<Record<string, unknown>>;
};
/** Retained URL progress sits above the existing import-preview service and app job. */
export class McpImportBatchService {
  private active?: McpImportBatchActive;
  private stopped = false;
  constructor(private readonly ports: Ports) {}
  private check(guard: () => void) {
    guard();
    if (this.stopped)
      throw new McpEditError(
        "access_denied",
        "Import preparation session stopped.",
      );
  }
  async prepare(
    owner: string,
    input: McpImportBatchPrepare,
    guard: () => void,
  ) {
    this.check(guard);
    const record = await this.ports.repository.prepare(owner, input, () =>
      this.check(guard),
    );
    return this.view(record, guard);
  }
  async get(owner: string, id: string, guard: () => void) {
    this.check(guard);
    const active = this.ownedActive(owner, id);
    const record =
      active?.record ?? (await this.ports.repository.load(owner, id));
    this.check(guard);
    return this.view(record, guard);
  }
  run(owner: string, input: McpImportBatchRun, context: McpOperationContext) {
    return this.exclusive(owner, input.id, context, (active) =>
      this.perform(active, input, context),
    );
  }
  publish(
    owner: string,
    input: McpImportBatchPublish,
    context: McpOperationContext,
  ) {
    return this.exclusive(owner, input.id, context, async (active) => {
      const signal = AbortSignal.any([
        active.controller.signal,
        context.signal,
      ]);
      const job = {
        ...context,
        signal,
        assertAuthorized: () => {
          signal.throwIfAborted();
          this.check(context.assertAuthorized);
        },
      };
      job.assertAuthorized();
      job.progress({
        phase: "import-batch-publishing",
        completed: 0,
        total: input.items.length,
      });
      return this.ports.publish(owner, input, job);
    });
  }
  private exclusive(
    owner: string,
    id: string,
    context: McpOperationContext,
    execute: (active: McpImportBatchActive) => Promise<Record<string, unknown>>,
  ) {
    this.check(context.assertAuthorized);
    if (this.active)
      throw new McpEditError(
        "editor_busy",
        "Wait for the active import operation and cleanup.",
      );
    const active: McpImportBatchActive = {
      jobId: context.id,
      id,
      owner,
      controller: new AbortController(),
      pause: false,
      done: Promise.resolve(),
    };
    this.active = active;
    const task = execute(active);
    active.done = task;
    return task.finally(() => {
      if (this.active === active) this.active = undefined;
    });
  }
  private async perform(
    active: McpImportBatchActive,
    input: McpImportBatchRun,
    context: McpOperationContext,
  ) {
    const record = await this.ports.repository.load(active.owner, input.id);
    const job = this.context(active, record, context);
    job.assertAuthorized();
    const previous = record.runs.find(
      (run) => run.requestId === input.requestId,
    );
    if (previous) {
      if (hashStableValue(previous) !== hashStableValue(input))
        throw new McpEditError(
          "invalid_edit",
          "Import run requestId belongs to different options.",
        );
      return {
        importBatch: importBatchReference({
          ...record,
          status: record.status === "running" ? "interrupted" : record.status,
        }),
      };
    }
    if (input.version !== record.version)
      throw new McpEditError(
        "revision_conflict",
        "Read the latest import plan version before resuming.",
      );
    if (record.runs.length >= 30)
      throw new McpEditError(
        "invalid_edit",
        "Import preparation run history is full.",
      );
    await this.validateSelections(record, input, job.assertAuthorized);
    record.runs.push(input);
    record.status = "running";
    record.errorCode = null;
    active.record = record;
    await checkpointImportBatch(this.ports, record, job.assertAuthorized);
    await executeImportBatch(this.ports, record, active, input, job);
    return { importBatch: importBatchReference(record) };
  }
  private context(
    active: McpImportBatchActive,
    record: McpImportBatchRecord,
    context: McpOperationContext,
  ) {
    const signal = AbortSignal.any([active.controller.signal, context.signal]);
    return {
      ...context,
      signal,
      assertAuthorized: () => {
        signal.throwIfAborted();
        this.check(context.assertAuthorized);
        if (record.expiresAt <= this.ports.now())
          throw new McpEditError(
            "not_found",
            "Import plan retention expired; no further scan is authorized.",
          );
      },
    };
  }
  private async validateSelections(
    record: McpImportBatchRecord,
    input: McpImportBatchRun,
    guard: () => void,
  ) {
    for (const id of [...input.retryItemIds, ...input.rescanExpiredItemIds]) {
      const row = record.items.find((item) => item.target.id === id);
      if (!row)
        throw new McpEditError(
          "invalid_edit",
          "Retry selection is outside the fixed URL plan.",
        );
      if (await retainedImportReceipt(this.ports, record.owner, row, guard))
        continue;
      const latest = row.attempts.at(-1);
      if (input.rescanExpiredItemIds.includes(id)) {
        if (
          !latest?.preview ||
          (await this.ports.previewStatus(
            record.owner,
            latest.preview,
            guard,
          )) !== "unavailable"
        )
          throw new McpEditError(
            "invalid_edit",
            "Rescan only an unavailable completed preview, not a live or unattempted item.",
          );
      } else if (!latest || latest.status === "ready") {
        throw new McpEditError(
          "invalid_edit",
          "Retry only a failed, cancelled or interrupted scan.",
        );
      }
    }
    guard();
  }
  async control(
    owner: string,
    id: string,
    action: "pause" | "cancel",
    guard: () => void,
  ) {
    this.check(guard);
    const active = this.ownedActive(owner, id);
    if (active) {
      if (action === "pause") active.pause = true;
      else {
        active.controller.abort();
        await this.ports.cancelJob(active.jobId, owner);
      }
    }
    return this.get(owner, id, guard);
  }
  async discard(owner: string, id: string, guard: () => void) {
    this.check(guard);
    if (this.ownedActive(owner, id))
      throw new McpEditError(
        "editor_busy",
        "Cancel and settle the batch before discarding its plan.",
      );
    return this.ports.repository.discard(owner, id, () => this.check(guard));
  }
  stop() {
    this.stopped = true;
    this.active?.controller.abort();
  }
  async close() {
    this.stop();
    await Promise.allSettled([this.active?.done]);
  }
  private ownedActive(owner: string, id: string) {
    if (this.active?.id !== id) return undefined;
    if (this.active.owner !== owner)
      throw new McpEditError(
        "not_found",
        "Import plan is not owned by this connection.",
      );
    return this.active;
  }
  private async view(value: McpImportBatchRecord, guard: () => void) {
    const record = structuredClone(value);
    const active = this.ownedActive(record.owner, record.id);
    const items = [];
    for (const row of record.items)
      items.push(
        await this.itemView(record.owner, row, Boolean(active), guard),
      );
    this.check(guard);
    const status = active
      ? "running"
      : record.status === "running"
        ? "interrupted"
        : record.status;
    return mcpImportBatchOutputs.carrot_get_import_batch.parse({
      ...importBatchReference(record),
      status:
        !active && items.every((item) => item.status === "imported")
          ? "completed"
          : status,
      createdAt: record.createdAt,
      pauseRequested: active?.pause ?? false,
      cancellationRequested: active?.controller.signal.aborted ?? false,
      attemptCount: record.items.reduce(
        (sum, row) => sum + row.attempts.length,
        0,
      ),
      maxAttempts: record.input.maxAttempts,
      errorCode: record.errorCode,
      items,
      warnings: [
        "Scanning only prepares previews. Review page IDs, then explicitly use carrot_import_chapters or carrot_import_batch_chapters. No models are run.",
        "The plan lasts seven days. Image previews last thirty minutes in the current session; reconstruction does not restore source bytes.",
        "A completed scan is not a completed import. Rescan of an unavailable preview must be explicitly selected and its duplicate risk acknowledged.",
        "Receipts are historical, not source deduplication or current chapter integrity. Grouped publication stores receipt mapping in the plan atomically; independent imports with discarded receipts may remain unknown after session loss.",
        "Discarding the plan does not discard independent previews, receipts or imported chapters. Release unwanted previews separately.",
      ],
    });
  }
  private async itemView(
    owner: string,
    row: McpImportBatchRow,
    active: boolean,
    guard: () => void,
  ) {
    const receipt = await retainedImportReceipt(this.ports, owner, row, guard);
    const latest = row.attempts.at(-1) ?? {
      status: "pending" as const,
      preview: null,
      errorCode: null,
    };
    const preview = latest.preview;
    let status:
      | "pending"
      | "scanning"
      | "ready"
      | "failed"
      | "cancelled"
      | "interrupted"
      | "preview_unavailable"
      | "checking"
      | "importing"
      | "imported" = latest.status;
    if (receipt) status = "imported";
    else if (preview) {
      const native = await this.ports.previewStatus(owner, preview, guard);
      status = native === "unavailable" ? "preview_unavailable" : native;
    } else if (status === "scanning" && !active) status = "interrupted";
    return {
      ...row.target,
      status,
      attemptCount: row.attempts.length,
      errorCode: latest.errorCode,
      preview,
      receipt: receipt ?? null,
    };
  }
}
