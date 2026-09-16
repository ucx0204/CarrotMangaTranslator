import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpPageEditScope } from "../../shared/mcpEditingTypes";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import { McpEditError } from "./mcpEditPolicy";

type Target = { chapterId: string; pageId: string; blockId: string };
type View = {
  state: "applied" | "undone" | "conflict" | "unavailable";
  reason: "ready" | "history_unavailable" | "page_changed" | "artifact_missing";
  revision?: PageRevision;
};
type Job = {
  kind: string;
  status: string;
  target?: { chapterId: string; pageId: string; blockId?: string };
  result?: {
    pagesChanged?: number;
    blocksErased?: number;
    cleanupFailed?: boolean;
  };
};
type Action = {
  jobId: string;
  requestId: string;
  revision: PageRevision;
  direction: "undo" | "redo";
};
type Receipt = Action & {
  status: "applied" | "already_applied";
  pagesChanged: number;
  target: Target;
};
type Ports = {
  readJob: (id: string, owner: string) => Promise<Job>;
  inspect: (transactionId: string, target: Target) => Promise<View>;
  apply: (
    transactionId: string,
    target: Target,
    direction: "undo" | "redo",
    revision: PageRevision,
    guard: () => void,
  ) => Promise<{ revision: PageRevision }>;
  withPageEdit: McpPageEditScope;
  notifySaved: (chapterId: string, pageId: string) => void;
};

/** Only the originating connection may replay its successful selected erasure.
 * References and action receipts deliberately do not survive MCP/app restart.
 * They never replace the app's image history, artifact retention or page locks. */
export class McpErasureRecoveryService {
  private readonly references = new Map<string, string>();
  private readonly actions = new Map<
    string,
    { fingerprint: string; result: Promise<Receipt> }
  >();
  private stopped = false;
  constructor(private readonly ports: Ports) {}

  remember(jobId: string, transactionId: string): void {
    if (this.stopped) return;
    if (this.references.size >= 512) {
      const oldest = this.references.keys().next().value;
      if (oldest) this.references.delete(oldest);
    }
    this.references.set(jobId, transactionId);
  }

  async inspect(jobId: string, owner: string, authorize: () => void) {
    this.check(authorize);
    const job = await this.ports.readJob(jobId, owner);
    this.check(authorize);
    const target = selectedTarget(job);
    const transactionId = this.references.get(jobId);
    const view =
      target && eligible(job) && transactionId
        ? await this.ports.inspect(transactionId, target)
        : {
            state: "unavailable" as const,
            reason: !target
              ? "not_selected_erasure"
              : !eligible(job)
                ? "job_not_completed"
                : "history_unavailable",
          };
    this.check(authorize);
    return {
      jobId,
      target,
      ...view,
      sessionOnly: true as const,
      canUndo: view.state === "applied",
      canRedo: view.state === "undone",
    };
  }

  async apply(
    action: Action,
    owner: string,
    authorize: () => void,
  ): Promise<Receipt> {
    this.check(authorize);
    // Ownership is checked even for a cached receipt. Never accept a caller's
    // transaction ID, page path or target replacement.
    await this.ports.readJob(action.jobId, owner);
    this.check(authorize);
    const key = JSON.stringify([owner, action.requestId]);
    const fingerprint = hashStableValue(action);
    const previous = this.actions.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new McpEditError(
          "invalid_edit",
          "requestId belongs to a different recovery action.",
        );
      const receipt = await previous.result;
      this.check(authorize);
      return {
        ...structuredClone(receipt),
        status: "already_applied",
        pagesChanged: 0,
      };
    }
    if (this.actions.size >= 512)
      throw new McpEditError(
        "invalid_edit",
        "Session recovery receipt limit reached. No history was changed.",
      );
    const result = Promise.resolve().then(() =>
      this.execute(action, owner, authorize),
    );
    this.actions.set(key, { fingerprint, result });
    // Failed actions remain recorded too: replay must never turn an uncertain
    // earlier commit into a second state change. Inspect before a new request.
    return structuredClone(await result);
  }

  stop(): void {
    this.stopped = true;
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled(
      [...this.actions.values()].map((entry) => entry.result),
    );
    this.references.clear();
    this.actions.clear();
  }

  private async execute(
    action: Action,
    owner: string,
    authorize: () => void,
  ): Promise<Receipt> {
    const first = await this.inspect(action.jobId, owner, authorize);
    if (!first.target)
      throw new McpEditError(
        "invalid_edit",
        "Only a single-block erasure job can be recovered.",
      );
    const target = first.target;
    const guard = () => this.check(authorize);
    return this.ports.withPageEdit(target, guard, async (assertAuthorized) => {
      const view = await this.inspect(action.jobId, owner, assertAuthorized);
      if (
        view.revision !== action.revision ||
        view.state !== (action.direction === "undo" ? "applied" : "undone")
      )
        throw new McpEditError(
          "revision_conflict",
          "Recovery is unavailable or the page changed. Inspect recovery again; subsequent edits are never overwritten.",
        );
      const transactionId = this.references.get(action.jobId);
      if (!transactionId)
        throw new McpEditError(
          "not_found",
          "Session image history is unavailable.",
        );
      const saved = await this.ports.apply(
        transactionId,
        target,
        action.direction,
        action.revision,
        assertAuthorized,
      );
      this.ports.notifySaved(target.chapterId, target.pageId);
      return {
        ...action,
        ...saved,
        target,
        status: "applied",
        pagesChanged: 1,
      };
    });
  }
  private check(authorize: () => void): void {
    authorize();
    if (this.stopped)
      throw new McpEditError("access_denied", "MCP recovery is stopping.");
  }
}
function selectedTarget(job: Job): Target | undefined {
  if (job.kind !== "erase" || !job.target?.blockId) return undefined;
  return {
    chapterId: job.target.chapterId,
    pageId: job.target.pageId,
    blockId: job.target.blockId,
  };
}
function eligible(job: Job): boolean {
  return (
    job.status === "completed" &&
    job.result?.pagesChanged === 1 &&
    job.result.blocksErased === 1 &&
    !job.result.cleanupFailed
  );
}
