import { isDeepStrictEqual } from "node:util";
import { McpOperationHistory } from "./mcpOperationHistory";
import type { McpJobPersistence } from "./mcpJobPersistence";
import {
  findOwnedMcpOperation,
  type McpOwnedOperationRequest,
} from "./mcpOperationLookup";
import {
  memoryMcpOperationRecord,
  projectMcpOperation,
  mcpRetryTarget,
  type McpOperationEntry,
} from "./mcpOperationState";
import { snapshotMcpEntry } from "./mcpOperationSnapshot";
import { randomUUID } from "node:crypto";
import {
  mcpOperationFile,
  mcpExportSource,
  mcpOperationOutputMetadata,
} from "./mcpOperationOutputs";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError, mcpStorageFailure } from "./mcpEditPolicy";
import type { McpStoredJobTarget } from "./mcpJobJournal";

type Progress = { phase: string; completed?: number; total?: number };
type Result = Record<string, unknown>;
export type McpOperationContext = {
  id: string;
  signal: AbortSignal;
  assertAuthorized: () => void;
  progress: (value: Progress) => void;
};
export type McpOperationExecutor = (
  target: McpStoredJobTarget,
  context: McpOperationContext,
) => Promise<Record<string, unknown>>;

type Start = {
  owner: string;
  requestId: string;
  kind: string;
  parameters: unknown;
  assertAuthorized: () => void;
  execute: (context: McpOperationContext) => Promise<Result>;
};

/** Durable transport receipts only. Execution still acquires the application's real activity/job lease. */
export class McpOperationService {
  private readonly history: McpOperationHistory;
  private readonly entries: Map<string, McpOperationEntry>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanup?: Promise<void>;
  private stopped = false;
  private fault?: Error;
  private initialization?: Promise<void>;
  private admissions: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly reportError: (error: unknown) => void,
    private readonly now: () => number = Date.now,
    private readonly persistence?: McpJobPersistence,
  ) {
    this.history = new McpOperationHistory(persistence, now);
    this.entries = this.history.live;
  }
  ready(): Promise<void> {
    this.initialization ??= this.restore();
    return this.initialization;
  }
  async start(input: Start) {
    input.assertAuthorized();
    await this.ready();
    const task = this.admissions.then(() => this.admit(input));
    this.admissions = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  /** Internal owned completion lease. Cancellation waits for native cleanup; no new work is admitted here. */
  async waitForCompletion(id: string, owner: string, signal: AbortSignal) {
    const entry = await this.get(id, owner);
    const cancel = () => {
      if (!entry.settled) {
        entry.cancellationRequested = true;
        entry.controller.abort();
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      await entry.done;
      return this.project(entry);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  /** Reads the exact owned receipt without admitting or re-executing work. */
  async findOwnedOperation(owner: string, input: McpOwnedOperationRequest) {
    await this.ready();
    const summary = this.history.previous(owner, input.requestId);
    const entry = summary
      ? findOwnedMcpOperation([await this.get(summary.id, owner)], owner, input)
      : undefined;
    return entry ? this.project(entry) : undefined;
  }
  async status(id: string, owner: string) {
    return this.project(await this.get(id, owner));
  }
  async file(id: string, owner: string, pageId?: string) {
    this.assertAvailable();
    const entry = await this.get(id, owner);
    this.assertAvailable();
    return mcpOperationFile(entry, pageId);
  }
  async outputMetadata(id: string, owner: string, pageId?: string) {
    this.assertAvailable();
    const entry = await this.get(id, owner);
    this.assertAvailable();
    return mcpOperationOutputMetadata(entry, pageId);
  }
  async exportSource(id: string, owner: string) {
    this.assertAvailable();
    const entry = await this.get(id, owner);
    this.assertAvailable();
    return mcpExportSource(entry);
  }
  async list(owner: string, offset: number, limit: number) {
    await this.ready();
    const records = this.history.list(owner);
    return {
      total: records.length,
      offset,
      limit,
      nextOffset: offset + limit < records.length ? offset + limit : null,
      jobs: await Promise.all(
        records
          .slice(offset, offset + limit)
          .map((entry) => this.status(entry.id, owner)),
      ),
    };
  }
  async retryTarget(id: string, owner: string, revision: string) {
    const entry = await this.get(id, owner);
    return mcpRetryTarget(entry, revision);
  }

  async cancel(id: string, owner: string) {
    await this.ready();
    const entry = await this.get(id, owner);
    if (!entry.settled) {
      entry.controller.abort();
      entry.cancellationRequested = true;
    }
    await this.commitCancellation(entry);
    return this.project(entry);
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.cleanupTimer);
    for (const entry of this.entries.values()) {
      if (!entry.settled) {
        entry.controller.abort();
        entry.cancellationRequested = true;
      }
    }
  }
  async close(): Promise<void> {
    this.stop();
    await this.ready();
    await this.admissions;
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
    await this.writes;
    await this.cleanup;
  }

  private async admit(input: Start) {
    this.assertAvailable();
    input.assertAuthorized();
    await this.prune();
    const fingerprint = hashStableValue([input.kind, input.parameters]);
    const summary = this.history.previous(input.owner, input.requestId);
    if (summary) {
      const previous = await this.get(summary.id, input.owner);
      if (
        previous.fingerprint !== fingerprint ||
        previous.kind !== input.kind ||
        !isDeepStrictEqual(previous.parameters, input.parameters)
      )
        throw new McpEditError(
          "invalid_edit",
          "requestId was already used for another operation.",
        );
      input.assertAuthorized();
      return this.project(previous);
    }
    if ([...this.entries.values()].some((entry) => !entry.settled))
      throw new McpEditError(
        "editor_busy",
        "An MCP operation is active. Inspect existing jobs first.",
      );
    input.assertAuthorized();
    const entry: McpOperationEntry = {
      id: randomUUID(),
      owner: input.owner,
      requestId: input.requestId,
      fingerprint,
      kind: input.kind,
      parameters: structuredClone(input.parameters),
      status: "running",
      progress: { phase: "queued" },
      startedAt: this.now(),
      cancellationRequested: false,
      settled: false,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.entries.set(entry.id, entry);
    try {
      await this.commit(entry);
    } catch (error) {
      this.entries.delete(entry.id);
      throw error;
    }
    entry.done = Promise.resolve().then(() => this.run(entry, input));
    return this.project(entry);
  }
  private async run(entry: McpOperationEntry, input: Start) {
    const deadline = setTimeout(
      () => entry.controller.abort(),
      2 * 60 * 60_000,
    );
    deadline.unref();
    const assertAuthorized = () => {
      entry.controller.signal.throwIfAborted();
      this.assertAvailable();
      input.assertAuthorized();
    };
    try {
      assertAuthorized();
      entry.result = await input.execute({
        id: entry.id,
        signal: entry.controller.signal,
        assertAuthorized,
        progress: (value) => {
          entry.progress = { ...value };
        },
      });
      entry.status =
        entry.result.status === "cancelled"
          ? "cancelled"
          : entry.result.status === "partial"
            ? "partial"
            : entry.result.status === "failed"
              ? "failed"
              : entry.result.status === "interrupted"
                ? "interrupted"
                : "completed";
    } catch (error) {
      entry.status = entry.controller.signal.aborted ? "cancelled" : "failed";
      entry.error =
        error instanceof McpEditError
          ? { code: error.code, message: error.message }
          : (mcpStorageFailure(error) ?? {
              code: entry.status,
              message:
                "The app could not finish this job. Inspect the current page and local log before retrying.",
            });
      this.reportError(error);
    } finally {
      clearTimeout(deadline);
      entry.finishedAt = this.now();
      entry.cancellationRequested = entry.controller.signal.aborted;
      await this.finish(entry);
    }
  }
  private async finish(entry: McpOperationEntry): Promise<void> {
    try {
      await this.commit(entry);
    } catch (error) {
      entry.status = "interrupted";
      entry.error = {
        code: "journal_unavailable",
        message:
          "The final receipt could not be saved. Page changes may already be committed; inspect the page before retrying.",
      };
      this.reportError(error);
    } finally {
      entry.settled = true;
      if (!this.fault) this.history.settle(entry, this.snapshot(entry));
    }
  }
  private async get(id: string, owner: string) {
    await this.ready();
    return this.history.get(id, owner);
  }
  private project(entry: McpOperationEntry) {
    return projectMcpOperation(entry, this.now(), Boolean(this.persistence));
  }
  private prune(): Promise<void> {
    this.cleanup ??= this.pruneBatch().finally(() => {
      this.cleanup = undefined;
    });
    return this.cleanup;
  }
  private async pruneBatch() {
    for (;;) {
      const expired = this.history.expiredBatch();
      for (const entry of expired) {
        try {
          await this.history.remove(entry);
        } catch (error) {
          this.reportError(error);
          return;
        }
      }
      if (expired.length < 128) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    try {
      await this.persistence?.cleanup(this.now());
    } catch (error) {
      this.reportError(error);
    }
  }
  private assertAvailable(): void {
    if (this.stopped)
      throw new McpEditError(
        "access_denied",
        "MCP is stopping; no new work is accepted.",
      );
    if (this.fault)
      throw new McpEditError(
        "access_denied",
        "MCP job storage is unavailable; no new work is accepted.",
      );
  }
  private async restore(): Promise<void> {
    const running = await this.history.open();
    for (const summary of running) {
      try {
        const entry = await this.history.get(summary.id, summary.owner);
        await this.commit(entry);
      } catch (error) {
        if (
          !(error instanceof McpEditError) ||
          error.code !== "job_detail_unavailable"
        )
          throw error;
        this.reportError(error);
        await this.history.update(summary.id, true);
      }
    }
    await this.prune();
    if (!this.stopped) {
      this.cleanupTimer = setInterval(() => {
        void this.prune();
      }, 10 * 60_000);
      this.cleanupTimer.unref();
    }
  }
  private snapshot(entry: McpOperationEntry) {
    return this.persistence
      ? snapshotMcpEntry(entry)
      : memoryMcpOperationRecord(entry);
  }
  private async commitCancellation(entry: McpOperationEntry) {
    if (entry.settled || !this.persistence) return this.commit(entry);
    const writing = this.writes.then(() => {
      if (this.fault) throw this.fault;
      return this.history.update(entry.id);
    });
    this.writes = writing.catch((error) => this.storageFailed(error));
    return writing;
  }
  private async commit(entry: McpOperationEntry): Promise<void> {
    try {
      const record = this.snapshot(entry);
      const writing = this.writes.then(async () => {
        if (this.fault) throw this.fault;
        await this.history.save(record);
      });
      this.writes = writing.catch((error) => this.storageFailed(error));
      await writing;
    } catch (error) {
      this.storageFailed(error);
      throw error;
    }
  }
  private storageFailed(error: unknown): void {
    this.fault ??=
      error instanceof Error ? error : new Error("MCP job storage failed.");
    for (const entry of this.entries.values())
      if (!entry.settled) entry.controller.abort();
  }
}
