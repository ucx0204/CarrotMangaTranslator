import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";
import {
  MCP_JOB_CAPACITY,
  MCP_JOB_RETENTION_MS,
  parseMcpJobJournal,
  persistedMcpJobResult,
  mcpJobTargetSchema,
  type McpJobPersistence,
  type McpStoredJob,
} from "./mcpJobJournal";

type Progress = { phase: string; completed?: number; total?: number };
type Result = Record<string, unknown>;
export type McpOperationContext = {
  id: string;
  signal: AbortSignal;
  assertAuthorized: () => void;
  progress: (value: Progress) => void;
};
type Start = {
  owner: string;
  requestId: string;
  kind: string;
  parameters: unknown;
  assertAuthorized: () => void;
  execute: (context: McpOperationContext) => Promise<Result>;
};
type RecordEntry = Omit<McpStoredJob, "parameters" | "kind" | "result"> & {
  parameters: unknown;
  kind: string;
  result?: Result;
  settled: boolean;
  controller: AbortController;
  done: Promise<void>;
};

/** Durable transport receipts only. Execution still acquires the application's real activity/job lease. */
export class McpOperationService {
  private readonly entries = new Map<string, RecordEntry>();
  private stopped = false;
  private fault?: Error;
  private initialization?: Promise<void>;
  private admissions: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly reportError: (error: unknown) => void,
    private readonly now: () => number = Date.now,
    private readonly persistence?: McpJobPersistence,
  ) {}
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
  status(id: string, owner: string) {
    return this.project(this.get(id, owner));
  }
  list(owner: string, offset: number, limit: number) {
    this.prune();
    const records = [...this.entries.values()]
      .filter((entry) => entry.owner === owner)
      .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
    return {
      total: records.length,
      offset,
      limit,
      nextOffset: offset + limit < records.length ? offset + limit : null,
      jobs: records
        .slice(offset, offset + limit)
        .map((entry) => this.project(entry)),
    };
  }
  retryTarget(id: string, owner: string, revision: string) {
    const entry = this.get(id, owner);
    if (
      !entry.settled ||
      !["failed", "cancelled", "interrupted"].includes(entry.status)
    )
      throw new McpEditError(
        "invalid_edit",
        "Only failed, cancelled or interrupted jobs can be retried.",
      );
    const target = mcpJobTargetSchema.parse(entry.parameters);
    if (target.revision !== revision)
      throw new McpEditError(
        "revision_conflict",
        "The original target revision is required. Inspect the current page; changed pages need a new explicit operation.",
      );
    return { kind: entry.kind, target: { ...target } };
  }
  async cancel(id: string, owner: string) {
    await this.ready();
    const entry = this.get(id, owner);
    if (!entry.settled) {
      entry.controller.abort();
      entry.cancellationRequested = true;
    }
    await this.commit();
    return this.project(entry);
  }
  stop(): void {
    this.stopped = true;
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
  }

  private async admit(input: Start) {
    this.assertAvailable();
    input.assertAuthorized();
    this.prune();
    const fingerprint = hashStableValue([input.kind, input.parameters]);
    const previous = [...this.entries.values()].find(
      (entry) =>
        entry.owner === input.owner && entry.requestId === input.requestId,
    );
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new McpEditError(
          "invalid_edit",
          "requestId was already used for another operation.",
        );
      return this.project(previous);
    }
    if (
      this.entries.size >= MCP_JOB_CAPACITY ||
      [...this.entries.values()].some((entry) => !entry.settled)
    )
      throw new McpEditError(
        "editor_busy",
        "An MCP operation is active or the retained journal is full. Inspect existing jobs first.",
      );
    const entry: RecordEntry = {
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
      await this.commit();
    } catch (error) {
      this.entries.delete(entry.id);
      throw error;
    }
    entry.done = Promise.resolve().then(() => this.run(entry, input));
    return this.project(entry);
  }
  private async run(entry: RecordEntry, input: Start) {
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
              : "completed";
    } catch (error) {
      entry.status = entry.controller.signal.aborted ? "cancelled" : "failed";
      entry.error =
        error instanceof McpEditError
          ? { code: error.code, message: error.message }
          : {
              code: entry.status,
              message:
                "The app could not finish this job. Inspect the current page and local log before retrying.",
            };
      this.reportError(error);
    } finally {
      clearTimeout(deadline);
      entry.finishedAt = this.now();
      entry.cancellationRequested = entry.controller.signal.aborted;
      await this.finish(entry);
    }
  }
  private async finish(entry: RecordEntry): Promise<void> {
    try {
      await this.commit();
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
    }
  }
  private get(id: string, owner: string) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner)
      throw new McpEditError(
        "not_found",
        "Operation not found for this connection. Job history is retained for seven days.",
      );
    return entry;
  }
  private project(entry: RecordEntry) {
    return structuredClone({
      jobId: entry.id,
      requestId: entry.requestId,
      kind: entry.kind,
      status: entry.settled ? entry.status : "running",
      cancellationRequested:
        entry.cancellationRequested || entry.controller.signal.aborted,
      progress:
        !entry.settled && entry.status !== "running"
          ? { phase: "saving_receipt" }
          : entry.progress,
      result: entry.settled ? entry.result : undefined,
      error: entry.settled ? entry.error : undefined,
      startedAt: entry.startedAt,
      finishedAt: entry.settled ? entry.finishedAt : undefined,
      target: mcpJobTargetSchema.safeParse(entry.parameters).data,
      persistence: this.persistence ? "durable" : "memory",
    });
  }
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (
        entry.settled &&
        entry.finishedAt !== undefined &&
        entry.finishedAt + MCP_JOB_RETENTION_MS <= this.now()
      )
        this.entries.delete(id);
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
    const value = await this.persistence?.load();
    if (value === undefined || value === null) return;
    for (const record of parseMcpJobJournal(value))
      this.entries.set(record.id, restoreEntry(record, this.now()));
    this.prune();
    await this.commit();
  }
  private async commit(): Promise<void> {
    const persistence = this.persistence;
    if (!persistence) return;
    try {
      const snapshot = snapshotEntries(this.entries.values());
      const writing = this.writes.then(() => {
        if (this.fault) throw this.fault;
        return persistence.save(snapshot);
      });
      // A failed queue tail remains awaitable for shutdown. The original writer
      // still rejects, while all future writes and executor commits fail closed.
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
function restoreEntry(record: McpStoredJob, now: number): RecordEntry {
  const interrupted = record.status === "running";
  const result = record.result ? { ...record.result } : undefined;
  if (result?.kind === "rendered-page-png")
    Object.assign(result, { artifactExpired: true });
  return {
    ...record,
    result,
    status: interrupted ? "interrupted" : record.status,
    progress: interrupted ? { phase: "interrupted" } : record.progress,
    finishedAt: interrupted ? now : record.finishedAt,
    error: interrupted
      ? {
          code: "interrupted",
          message:
            "The server stopped before final receipt commit. Inspect the saved page before an explicit retry.",
        }
      : record.error,
    controller: new AbortController(),
    settled: true,
    done: Promise.resolve(),
  };
}

function snapshotEntries(entries: Iterable<RecordEntry>) {
  const records = [...entries].map((entry) => ({
    id: entry.id,
    owner: entry.owner,
    requestId: entry.requestId,
    fingerprint: entry.fingerprint,
    kind: entry.kind,
    parameters: entry.parameters,
    status: entry.status,
    progress: entry.progress,
    result: persistedMcpJobResult(entry.result),
    error: entry.error,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    cancellationRequested:
      entry.cancellationRequested || entry.controller.signal.aborted,
  }));
  return { version: 1, records: parseMcpJobJournal({ version: 1, records }) };
}
