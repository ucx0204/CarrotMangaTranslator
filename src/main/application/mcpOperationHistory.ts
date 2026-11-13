import { isDeepStrictEqual } from "node:util";
import { McpEditError } from "./mcpEditPolicy";
import {
  summarizeMcpJob,
  type McpJobPersistence,
  type McpJobSummary,
} from "./mcpJobPersistence";
import {
  restoreMcpOperationEntry,
  type McpOperationEntry,
} from "./mcpOperationState";
import { MCP_JOB_RETENTION_MS, type McpStoredJob } from "./mcpJobJournal";

const CACHE_BYTES = 32 * 1024 * 1024;
/** Indexes contain identities only. Cache eviction never invokes restart recovery. */
export class McpOperationHistory {
  readonly live = new Map<string, McpOperationEntry>();
  private readonly summaries = new Map<string, McpJobSummary>();
  private readonly requests = new Map<string, string>();
  private readonly owners = new Map<string, Set<string>>();
  private readonly restored = new Set<string>();
  private readonly cache = new Map<
    string,
    { record: McpStoredJob; bytes: number }
  >();
  private readonly volatile = new Map<string, McpStoredJob>();
  private readonly sessionResults = new Map<
    string,
    McpOperationEntry["result"]
  >();
  private cacheBytes = 0;
  constructor(
    readonly persistence: McpJobPersistence | undefined,
    private readonly now: () => number,
  ) {}
  async open() {
    for (const summary of (await this.persistence?.open()) ?? []) {
      if (
        this.summaries.has(summary.id) ||
        (!this.expired(summary) && this.requests.has(this.key(summary)))
      )
        throw new Error("Duplicate MCP job identity.");
      this.index(summary);
      this.restored.add(summary.id);
    }
    return [...this.summaries.values()].filter(
      (record) => record.status === "running",
    );
  }
  previous(owner: string, requestId: string) {
    const id = this.requests.get(JSON.stringify([owner, requestId]));
    const summary = id ? this.summaries.get(id) : undefined;
    return summary && !this.expired(summary) ? summary : undefined;
  }
  async get(id: string, owner: string) {
    const current = this.live.get(id);
    const summary = this.summaries.get(id);
    this.assertOwned(current, summary, owner);
    if (current) return current;
    const record = await this.read(id);
    this.assertOwned(this.live.get(id), this.summaries.get(id), owner);
    if (this.restored.has(id))
      return restoreMcpOperationEntry(record, this.now());
    return {
      ...record,
      result: this.sessionResults.get(id) ?? record.result,
      settled: true,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
  }
  private assertOwned(
    current: McpOperationEntry | undefined,
    summary: McpJobSummary | undefined,
    owner: string,
  ) {
    const identity = current ?? summary;
    const expired =
      current?.settled !== false && summary && this.expired(summary);
    if (!identity || identity.owner !== owner || expired)
      throw new McpEditError(
        "not_found",
        "Operation not found for this connection. Job history is retained for seven days.",
      );
  }
  list(owner: string) {
    return [...(this.owners.get(owner) ?? [])]
      .flatMap((id) => {
        const summary = this.summaries.get(id);
        return summary ? [summary] : [];
      })
      .filter((s) => !this.expired(s))
      .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  }
  async save(record: McpStoredJob) {
    const old = this.summaries.get(record.id);
    const next = this.persistence
      ? await this.persistence.save(record, old?.revision ?? null)
      : summarizeMcpJob(record, (old?.revision ?? 0) + 1);
    if (!this.persistence)
      this.volatile.set(record.id, structuredClone(record));
    this.index(next);
    this.put(record);
  }
  async update(id: string, interrupted = false) {
    const old = this.summaries.get(id);
    if (!old) throw new Error("Missing job identity");
    const finishedAt = this.now();
    const changes = interrupted
      ? {
          status: "interrupted" as const,
          cancellationRequested: old.cancellationRequested,
          finishedAt,
          expiresAt: finishedAt + MCP_JOB_RETENTION_MS,
        }
      : {
          status: old.status,
          cancellationRequested: true,
          finishedAt: old.finishedAt,
          expiresAt: old.expiresAt,
        };
    const next = this.persistence
      ? await this.persistence.update(id, old.revision, changes)
      : { ...old, ...changes, revision: old.revision + 1 };
    this.index(next);
    this.drop(id);
  }
  settle(entry: McpOperationEntry, record?: McpStoredJob) {
    if (record && !isDeepStrictEqual(entry.result, record.result))
      this.sessionResults.set(entry.id, entry.result);
    for (const [id, value] of this.live) {
      if (value.settled) this.live.delete(id);
    }
    // Same bounded session-only evidence lifetime as the former recent tier.
    while (this.sessionResults.size > 512) {
      const oldest = this.sessionResults.keys().next().value;
      if (oldest === undefined) break;
      this.sessionResults.delete(oldest);
    }
  }
  expiredBatch() {
    return [...this.summaries.values()]
      .filter((s) => this.expired(s) && !this.live.has(s.id))
      .slice(0, 128);
  }
  async remove(summary: McpJobSummary) {
    await this.persistence?.remove(summary.id, summary.revision, this.now());
    this.summaries.delete(summary.id);
    if (this.requests.get(this.key(summary)) === summary.id)
      this.requests.delete(this.key(summary));
    const owner = this.owners.get(summary.owner);
    owner?.delete(summary.id);
    if (!owner?.size) this.owners.delete(summary.owner);
    this.drop(summary.id);
    this.volatile.delete(summary.id);
    this.restored.delete(summary.id);
    this.sessionResults.delete(summary.id);
  }
  private async read(id: string) {
    const cached = this.cache.get(id);
    if (cached) {
      this.cache.delete(id);
      this.cache.set(id, cached);
      return structuredClone(cached.record);
    }
    const record = this.persistence
      ? await this.persistence.read(id)
      : this.volatile.get(id);
    if (!record)
      throw new McpEditError(
        "job_detail_unavailable",
        "Saved job detail is missing; its request remains protected.",
      );
    this.put(record);
    return structuredClone(record);
  }
  private put(record: McpStoredJob) {
    this.drop(record.id);
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (bytes > CACHE_BYTES) return;
    while (this.cacheBytes + bytes > CACHE_BYTES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    this.cache.set(record.id, { record: structuredClone(record), bytes });
    this.cacheBytes += bytes;
  }
  private drop(id: string) {
    this.cacheBytes -= this.cache.get(id)?.bytes ?? 0;
    this.cache.delete(id);
  }
  private index(summary: McpJobSummary) {
    this.summaries.set(summary.id, summary);
    if (!this.expired(summary))
      this.requests.set(this.key(summary), summary.id);
    const ids = this.owners.get(summary.owner) ?? new Set<string>();
    ids.add(summary.id);
    this.owners.set(summary.owner, ids);
  }
  private key(summary: Pick<McpJobSummary, "owner" | "requestId">) {
    return JSON.stringify([summary.owner, summary.requestId]);
  }
  private expired(summary: McpJobSummary) {
    return summary.expiresAt !== undefined && summary.expiresAt <= this.now();
  }
}
