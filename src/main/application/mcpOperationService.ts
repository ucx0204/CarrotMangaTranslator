import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";

type Progress = { phase: string; completed?: number; total?: number };
type Result = Record<string, unknown>;
export type McpOperationContext = {
  id: string;
  signal: AbortSignal;
  assertAuthorized: () => void;
  progress: (value: Progress) => void;
};
type RecordEntry = {
  id: string;
  owner: string;
  requestId: string;
  fingerprint: string;
  kind: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  progress: Progress;
  result?: Result;
  error?: { code: string; message: string };
  startedAt: number;
  finishedAt?: number;
  controller: AbortController;
  done: Promise<void>;
};

/** Transport receipts only. The executor must acquire the app's existing job/activity
 * lease; this service never owns a second GPU queue or bypasses library transactions. */
export class McpOperationService {
  private readonly entries = new Map<string, RecordEntry>();
  private stopped = false;
  constructor(
    private readonly reportError: (error: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(input: {
    owner: string;
    requestId: string;
    kind: string;
    parameters: unknown;
    assertAuthorized: () => void;
    execute: (context: McpOperationContext) => Promise<Result>;
  }) {
    input.assertAuthorized();
    if (this.stopped) throw unavailable();
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
      this.entries.size >= 64 ||
      [...this.entries.values()].some((entry) => entry.status === "running")
    )
      throw new McpEditError(
        "editor_busy",
        "An MCP operation is active or its receipt capacity is full. Query the existing operation first.",
      );
    const entry: RecordEntry = {
      id: randomUUID(),
      owner: input.owner,
      requestId: input.requestId,
      fingerprint,
      kind: input.kind,
      status: "running",
      progress: { phase: "queued" },
      startedAt: this.now(),
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.entries.set(entry.id, entry);
    // Defer execution until a receipt is available; every rejection is observed.
    entry.done = Promise.resolve().then(() => this.run(entry, input));
    return this.project(entry);
  }

  status(id: string, owner: string) {
    return this.project(this.get(id, owner));
  }
  cancel(id: string, owner: string) {
    const entry = this.get(id, owner);
    if (entry.status === "running") entry.controller.abort();
    return this.project(entry);
  }
  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values())
      if (entry.status === "running") entry.controller.abort();
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
  }

  private async run(
    entry: RecordEntry,
    input: {
      assertAuthorized: () => void;
      execute: (context: McpOperationContext) => Promise<Result>;
    },
  ) {
    const deadline = setTimeout(() => entry.controller.abort(), 30 * 60_000);
    deadline.unref();
    const assertAuthorized = () => {
      entry.controller.signal.throwIfAborted();
      input.assertAuthorized();
      if (this.stopped) throw unavailable();
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
      // The executor returns only after committing. A late cancel must not falsely
      // report an already committed page as rolled back.
      entry.status =
        entry.result.status === "cancelled"
          ? "cancelled"
          : entry.result.status === "partial"
            ? "partial"
            : "completed";
    } catch (error) {
      entry.status = entry.controller.signal.aborted ? "cancelled" : "failed";
      entry.error =
        error instanceof McpEditError
          ? { code: error.code, message: error.message }
          : {
              code: entry.status,
              message:
                entry.status === "cancelled"
                  ? "Operation cancelled; reread the page to check any committed result."
                  : "The app could not complete this operation. Check the local app log.",
            };
      this.reportError(error);
    } finally {
      clearTimeout(deadline);
      entry.finishedAt = this.now();
    }
  }
  private get(id: string, owner: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner)
      throw new McpEditError(
        "not_found",
        "Operation not found for this connection. Receipts expire and do not survive a server restart; reread the page before retrying.",
      );
    return entry;
  }
  private project(entry: RecordEntry) {
    return {
      jobId: entry.id,
      requestId: entry.requestId,
      kind: entry.kind,
      status: entry.status,
      cancellationRequested: entry.controller.signal.aborted,
      progress: { ...entry.progress },
      result: entry.result,
      error: entry.error,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
    };
  }
  private prune(): void {
    for (const [id, entry] of this.entries)
      if (
        entry.finishedAt !== undefined &&
        entry.finishedAt + 60 * 60_000 < this.now()
      )
        this.entries.delete(id);
  }
}
function unavailable() {
  return new McpEditError(
    "access_denied",
    "MCP is stopping; no new work is accepted.",
  );
}
