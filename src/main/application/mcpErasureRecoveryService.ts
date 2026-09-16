import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpPageEditScope } from "../../shared/mcpEditingTypes";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import { McpEditError } from "./mcpEditPolicy";

type Target = { chapterId: string; pageId: string; blockId: string };
type View = {
  state: "applied" | "undone" | "conflict" | "unavailable";
  reason: "ready" | "history_unavailable" | "page_changed" | "artifact_missing" | "not_selected_erasure" | "job_not_completed";
  revision?: PageRevision;
};
type Job = {
  kind: string;
  status: string;
  target?: { chapterId: string; pageId: string; blockId?: string };
  result?: { pagesChanged?: number; blocksErased?: number; cleanupFailed?: boolean };
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
  inspect: (id: string, target: Target) => Promise<View>;
  apply: (id: string, target: Target, direction: "undo" | "redo", revision: PageRevision, guard: () => void) => Promise<{ revision: PageRevision }>;
  withPageEdit: McpPageEditScope;
  notifySaved: (chapterId: string, pageId: string) => void;
};

/** Session-only transport associations, not another image history. Native page
 * ownership and native history own all data and replay. A retry never toggles. */
export class McpErasureRecoveryService {
  private readonly references = new Map<string, string>();
  private readonly actions = new Map<string, { fingerprint: string; result: Promise<Receipt> }>();
  private stopped = false;
  constructor(private readonly ports: Ports) {}

  remember(jobId: string, transactionId: string): void {
    if (this.stopped || this.references.has(jobId)) return;
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
    const id = this.references.get(jobId);
    const view: View = target && eligible(job) && id
      ? await this.ports.inspect(id, target)
      : { state: "unavailable", reason: unavailableReason(job, target, id) };
    this.check(authorize);
    return {
      jobId, target, ...view, sessionOnly: true as const,
      canUndo: view.state === "applied", canRedo: view.state === "undone",
    };
  }

  async apply(action: Action, owner: string, authorize: () => void): Promise<Receipt> {
    this.check(authorize);
    // Recheck ownership and permissions even for historical retry receipts.
    await this.ports.readJob(action.jobId, owner);
    this.check(authorize);
    const key = JSON.stringify([owner, action.requestId]);
    const fingerprint = hashStableValue(action);
    const previous = this.actions.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new McpEditError("invalid_edit", "requestId belongs to a different recovery action.");
      const receipt = await previous.result;
      this.check(authorize);
      return { ...structuredClone(receipt), status: "already_applied", pagesChanged: 0 };
    }
    if (this.actions.size >= 512)
      throw new McpEditError("invalid_edit", "Session recovery receipt limit reached. No history was changed.");
    const result = Promise.resolve().then(() => this.execute(action, owner, authorize));
    this.actions.set(key, { fingerprint, result });
    // Keep failures too: an uncertain post-commit response must not be reexecuted.
    const receipt = await result;
    this.check(authorize);
    return structuredClone(receipt);
  }

  stop(): void { this.stopped = true; }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.actions.values()].map((entry) => entry.result));
    this.references.clear();
    this.actions.clear();
  }

  private async execute(action: Action, owner: string, authorize: () => void): Promise<Receipt> {
    const first = await this.inspect(action.jobId, owner, authorize);
    if (!first.target)
      throw new McpEditError("invalid_edit", "Only a single-block erasure job can be recovered.");
    const target = first.target;
    return this.ports.withPageEdit(target, () => this.check(authorize), async (assertAuthorized) => {
      const view = await this.inspect(action.jobId, owner, assertAuthorized);
      if (view.revision !== action.revision || view.state !== (action.direction === "undo" ? "applied" : "undone"))
        throw new McpEditError("revision_conflict", "Recovery is unavailable or the page changed. Inspect again; subsequent edits are never overwritten.");
      const id = this.references.get(action.jobId);
      if (!id) throw new McpEditError("not_found", "Session image history is unavailable.");
      const saved = await this.ports.apply(id, target, action.direction, action.revision, assertAuthorized);
      this.ports.notifySaved(target.chapterId, target.pageId);
      return { ...action, ...saved, target, status: "applied", pagesChanged: 1 };
    });
  }
  private check(authorize: () => void): void {
    authorize();
    if (this.stopped) throw new McpEditError("access_denied", "MCP recovery is stopping.");
  }
}
function selectedTarget(job: Job): Target | undefined {
  if (job.kind !== "erase" || !job.target?.blockId) return undefined;
  return { chapterId: job.target.chapterId, pageId: job.target.pageId, blockId: job.target.blockId };
}
function eligible(job: Job): boolean {
  return job.status === "completed" && job.result?.pagesChanged === 1 && job.result.blocksErased === 1 && !job.result.cleanupFailed;
}
function unavailableReason(job: Job, target: Target | undefined, id: string | undefined): View["reason"] {
  if (!target) return "not_selected_erasure";
  if (!eligible(job)) return "job_not_completed";
  if (!id) return "history_unavailable";
  return "history_unavailable";
}
