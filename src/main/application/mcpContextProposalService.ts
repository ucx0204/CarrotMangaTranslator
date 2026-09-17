import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpContextApplySchema, McpContextInspectSchema, McpContextPreviewSchema, McpExternalResearchSchema, mcpContextOutputSchemas, mcpContextRevision, type McpContextChangeSummary, type McpContextPreview } from "../../shared/mcpContextEditing";
import { assertContextTarget, planMcpContextChanges, type McpContextPlanOptions, type McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";
import type { WorkStyleGuide, ChapterStoryMemory } from "../../shared/workContextTypes";
import type { z } from "zod/v4";

type Receipt = z.infer<typeof mcpContextOutputSchemas.carrot_apply_context_proposal>;
type Metadata = z.infer<typeof mcpContextOutputSchemas.carrot_preview_context_edit>;
type Ports = {
  read: (chapterId: string) => Promise<McpContextSnapshot>;
  commit: (chapterId: string, transform: (current: McpContextSnapshot) => {
    styleGuide?: WorkStyleGuide; storyMemory?: ChapterStoryMemory; result: Receipt;
  }, guard: () => void) => Promise<Receipt>;
  withEdit: (snapshot: { chapterId: string; workId: string }, request: McpContextPreview,
    signal: AbortSignal, run: () => Promise<Receipt>) => Promise<Receipt>;
};
type Entry = {
  owner: string; fingerprint: string; request: McpContextPreview;
  metadata: Metadata; changes: McpContextChangeSummary[]; options: McpContextPlanOptions;
  applied?: Receipt;
};
const TTL = 30 * 60_000;
const CAPACITY = 128;

/** Session-local proposals, never an alternate library. All commits go through
 * the app's context lease and atomic write queue. Network/model results are data. */
export class McpContextProposalService {
  private readonly entries = new Map<string, Entry>();
  private readonly receipts = new Map<string, { fingerprint: string; receipt: Receipt; expiresAt: number }>();
  private readonly stopping = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly ports: Ports, private readonly now = Date.now) {}

  preview(owner: string, input: unknown, guard: () => void) {
    return this.enqueue(() => this.prepare(owner, McpContextPreviewSchema.parse(input), "edit", [], [], guard));
  }
  previewResearch(owner: string, input: unknown, guard: () => void) {
    const parsed = McpExternalResearchSchema.parse(input);
    return this.enqueue(() => this.prepare(owner, { ...parsed, changes: parsed.changes.map((item) => item.change) },
      "external-research", parsed.changes.map((item) => ({ changeId: item.change.changeId, reason: item.reason, sources: item.sources })),
      ["External sources are caller-supplied, not fetched or verified by this server. Research is not page-read memory."], guard));
  }
  previewAppResearch(owner: string, input: McpContextPreview,
    evidence: Array<Pick<McpContextChangeSummary, "changeId" | "reason" | "sources">>, warnings: string[], guard: () => void) {
    return this.enqueue(() => this.prepare(owner, McpContextPreviewSchema.parse(input), "app-research", evidence, warnings, guard));
  }
  inspect(owner: string, input: unknown, guard: () => void) {
    this.check(guard);
    const { proposalId, offset, limit } = McpContextInspectSchema.parse(input);
    const entry = this.owned(owner, proposalId);
    return structuredClone({ ...entry.metadata, total: entry.changes.length, offset, limit,
      nextOffset: offset + limit < entry.changes.length ? offset + limit : null,
      changes: entry.changes.slice(offset, offset + limit) });
  }
  apply(owner: string, input: unknown, guard: () => void): Promise<Receipt> {
    const request = McpContextApplySchema.parse(input);
    return this.enqueue(() => this.applySelected(owner, request, guard));
  }
  stop(): void { this.stopping.abort(); }
  async close(): Promise<void> {
    this.stop();
    await this.queue;
    this.entries.clear();
    this.receipts.clear();
  }

  private async prepare(owner: string, request: McpContextPreview, source: Metadata["source"],
    evidence: Array<Pick<McpContextChangeSummary, "changeId" | "reason" | "sources">>, warnings: string[], guard: () => void) {
    this.check(guard);
    this.prune();
    const fingerprint = hashStableValue({ request, source, evidence, warnings });
    const previous = [...this.entries.values()].find((entry) => entry.owner === owner && entry.request.requestId === request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new McpEditError("invalid_edit", "requestId belongs to a different context proposal.");
      return structuredClone(previous.metadata);
    }
    if (this.entries.size >= CAPACITY) throw new McpEditError("editor_busy", "Context proposal capacity reached; wait for expiry.");
    const snapshot = await this.ports.read(request.chapterId);
    this.check(guard);
    const now = new Date(Math.max(this.now(), Date.parse(snapshot.styleGuide.updatedAt) + 1, Date.parse(snapshot.storyMemory.updatedAt) + 1)).toISOString();
    const options: McpContextPlanOptions = { now, entryIds: {}, origin: source === "edit" ? "manual" : "ai" };
    const plan = planMcpContextChanges(snapshot, request, options);
    const changes = plan.changes.map((change) => ({ ...change, ...evidence.find((item) => item.changeId === change.changeId) }));
    if (Buffer.byteLength(JSON.stringify(changes), "utf8") > 256 * 1024)
      throw new McpEditError("invalid_edit", "Proposal is too large; split it into smaller explicit reviews.");
    const metadata = mcpContextOutputSchemas.carrot_preview_context_edit.parse({
      proposalId: randomUUID(), chapterId: request.chapterId, workId: snapshot.workId,
      revision: request.revision, source, changeIds: changes.map((item) => item.changeId),
      expiresAt: this.now() + TTL, warnings,
    });
    this.entries.set(metadata.proposalId, { owner, fingerprint, request: structuredClone(request), metadata, changes, options });
    return structuredClone(metadata);
  }

  private async applySelected(owner: string, request: z.infer<typeof McpContextApplySchema>, guard: () => void): Promise<Receipt> {
    this.check(guard);
    this.prune();
    const key = JSON.stringify([owner, request.requestId]);
    const fingerprint = hashStableValue(request);
    const cached = this.receipts.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw new McpEditError("invalid_edit", "requestId belongs to a different application.");
      return { ...structuredClone(cached.receipt), status: "already_applied" };
    }
    if (this.receipts.size >= 512) throw new McpEditError("editor_busy", "Application receipt capacity reached; wait for expiry.");
    const entry = this.owned(owner, request.proposalId);
    if (entry.applied) throw new McpEditError("invalid_edit", "This proposal was already applied. Create a new preview for further changes.");
    const selected = new Set(request.selectedChangeIds);
    if (selected.size !== request.selectedChangeIds.length || [...selected].some((id) => !entry.metadata.changeIds.includes(id)))
      throw new McpEditError("invalid_edit", "Select distinct change IDs from this proposal.");
    const subset = { ...entry.request, changes: entry.request.changes.filter((item) => selected.has(item.changeId)) };
    const check = () => { this.check(guard); this.owned(owner, request.proposalId); };
    const receipt = await this.ports.withEdit(entry.metadata, subset, this.stopping.signal, () =>
      this.ports.commit(entry.request.chapterId, (current) => {
        check();
        assertContextTarget(current, entry.request.chapterId, entry.metadata.revision);
        const plan = planMcpContextChanges(current, subset, entry.options);
        assertReviewedChanges(plan.changes, entry.changes);
        return {
          ...(plan.guideChanged ? { styleGuide: plan.styleGuide } : {}),
          ...(plan.memoryChanged ? { storyMemory: plan.storyMemory } : {}),
          result: mcpContextOutputSchemas.carrot_apply_context_proposal.parse({
            proposalId: request.proposalId, requestId: request.requestId, status: "applied",
            previousRevision: entry.metadata.revision,
            revision: mcpContextRevision({ ...current, styleGuide: plan.styleGuide, storyMemory: plan.storyMemory }),
            changesApplied: plan.changes.filter((item) => item.changed).length,
            selectedChangeIds: request.selectedChangeIds, pagesChanged: 0,
            note: "Only selected context fields were applied. Translations, images and page blocks were not changed. Receipt revision is historical; read current context before another edit.",
          }),
        };
      }, check));
    entry.applied = receipt;
    this.receipts.set(key, { fingerprint, receipt: structuredClone(receipt), expiresAt: this.now() + TTL });
    return receipt;
  }
  private check(guard: () => void): void { this.stopping.signal.throwIfAborted(); guard(); }
  private owned(owner: string, id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.metadata.expiresAt <= this.now())
      throw new McpEditError("not_found", "Context proposal is missing, expired or belongs to another connection. Create a new preview.");
    return entry;
  }
  private prune(): void {
    for (const [key, value] of this.entries) if (value.metadata.expiresAt <= this.now()) this.entries.delete(key);
    for (const [key, value] of this.receipts) if (value.expiresAt <= this.now()) this.receipts.delete(key);
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(run);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}

function assertReviewedChanges(actual: McpContextChangeSummary[], expected: McpContextChangeSummary[]): void {
  for (const change of actual) {
    const reviewed = expected.find((item) => item.changeId === change.changeId);
    if (!reviewed || hashStableValue([change.before, change.after]) !== hashStableValue([reviewed.before, reviewed.after]))
      throw new McpEditError("revision_conflict", "The selected context change no longer matches its reviewed result.");
  }
}
