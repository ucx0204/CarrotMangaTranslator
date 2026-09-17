import { randomUUID } from "node:crypto";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  McpStructurePreviewSchema,
  McpStructureActionSchema,
  type McpStructurePreview,
  type McpStructureAction,
  type McpStructureDirection,
  type McpStructureReceipt,
} from "../../shared/mcpBlockStructure";
import { planMcpStructure, type StructurePlan } from "./mcpStructurePolicy";
import type { McpPageEditService } from "./mcpPageEditService";
import { McpEditError } from "./mcpEditPolicy";

type Entry = {
  id: string;
  owner: string;
  request: McpStructurePreview;
  signature: string;
  plan: StructurePlan;
  state: "proposed" | "applied" | "undone";
  expectedRevision: string;
  reviewHash: string;
  expiresAt: number;
  bytes: number;
  busy: boolean;
  receipts: Map<string, { signature: string; value: McpStructureReceipt }>;
};
const TTL = 30 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
/** Session-only plans and history. Storage, page leases and commit-time authorization
 * stay in McpPageEditService. No second model runner or persistence layer. */
export class McpStructureService {
  private entries = new Map<string, Entry>();
  private stopped = false;
  private pendingActions = new Map<string, string>();
  constructor(
    private readonly edits: Pick<
      McpPageEditService,
      "readStructurePage" | "commitStructure"
    >,
    private readonly now = Date.now,
    lifetime?: AbortSignal,
  ) {
    if (lifetime?.aborted) this.stop();
    else lifetime?.addEventListener("abort", () => this.stop(), { once: true });
  }
  stop() {
    this.stopped = true;
    this.entries.clear();
    this.pendingActions.clear();
  }
  private guard(owner: string, authorize: () => void) {
    authorize();
    if (!owner || this.stopped)
      throw new McpEditError(
        "access_denied",
        "This editing session is unavailable.",
      );
  }
  private prune() {
    for (const [id, entry] of this.entries)
      if (!entry.busy && entry.expiresAt <= this.now()) this.entries.delete(id);
  }
  private owned(owner: string, id: string, authorize: () => void) {
    this.guard(owner, authorize);
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner)
      throw new McpEditError(
        "not_found",
        "Structure edit is absent or expired. Inspect the page and make a new preview.",
      );
    return entry;
  }
  private repeatedPreview(
    owner: string,
    request: McpStructurePreview,
    signature: string,
  ) {
    const prior = [...this.entries.values()].find(
      (entry) =>
        entry.owner === owner && entry.request.requestId === request.requestId,
    );
    if (prior && prior.signature !== signature)
      throw new McpEditError(
        "invalid_edit",
        "This preview requestId was already used for different input.",
      );
    return prior;
  }
  async preview(
    owner: string,
    input: McpStructurePreview,
    authorize: () => void,
  ) {
    this.guard(owner, authorize);
    const parsed = McpStructurePreviewSchema.safeParse(input);
    if (!parsed.success)
      throw new McpEditError("invalid_edit", "Invalid structure preview.");
    const request = parsed.data;
    const signature = JSON.stringify(request);
    this.prune();
    const prior = this.repeatedPreview(owner, request, signature);
    if (prior) return this.inspect(owner, prior.id, authorize);
    const page = await this.edits.readStructurePage(request);
    this.guard(owner, authorize);
    const raced = this.repeatedPreview(owner, request, signature);
    if (raced) return this.inspect(owner, raced.id, authorize);
    if (createPageRevision(page) !== request.revision)
      throw new McpEditError(
        "revision_conflict",
        "Read the page again before planning a structure edit.",
      );
    const plan = planMcpStructure(page, request, randomUUID);
    const bytes =
      Buffer.byteLength(JSON.stringify(plan)) + Buffer.byteLength(signature);
    if (
      this.entries.size >= 64 ||
      bytes +
        [...this.entries.values()].reduce(
          (sum, entry) => sum + entry.bytes,
          0,
        ) >
        MAX_BYTES
    )
      throw new McpEditError(
        "editor_busy",
        "Session structure-history capacity reached. Wait for expiry; no edit was saved.",
      );
    const entry: Entry = {
      id: randomUUID(),
      owner,
      request,
      signature,
      plan,
      state: "proposed",
      expectedRevision: request.revision,
      reviewHash: hashStableValue(page.soundEffectReview ?? null),
      expiresAt: this.now() + TTL,
      bytes,
      busy: false,
      receipts: new Map(),
    };
    this.entries.set(entry.id, entry);
    return this.view(entry, page);
  }
  async inspect(owner: string, id: string, authorize: () => void) {
    const entry = this.owned(owner, id, authorize);
    let page: MangaPage | undefined;
    try {
      page = await this.edits.readStructurePage(entry.request);
    } catch (error) {
      if (!(error instanceof McpEditError) || error.code !== "not_found")
        throw error;
    }
    this.owned(owner, id, authorize);
    return this.view(entry, page);
  }
  private view(entry: Entry, page?: MangaPage) {
    const currentRevision = page ? createPageRevision(page) : null;
    const blockedReason = !page
      ? ("page_missing" as const)
      : entry.busy || page.analysisStatus === "running"
        ? ("busy" as const)
        : currentRevision !== entry.expectedRevision ||
            hashStableValue(page.soundEffectReview ?? null) !== entry.reviewHash
          ? ("revision_conflict" as const)
          : null;
    return structuredClone({
      editId: entry.id,
      chapterId: entry.request.chapterId,
      pageId: entry.request.pageId,
      kind: entry.request.operation.kind,
      reason: entry.request.reason,
      state: entry.state,
      baseRevision: entry.request.revision,
      expectedRevision: entry.expectedRevision,
      currentRevision,
      expiresAt: entry.expiresAt,
      blockedReason,
      canApply: !blockedReason && entry.state === "proposed",
      canUndo: !blockedReason && entry.state === "applied",
      canRedo: !blockedReason && entry.state === "undone",
      before: entry.plan.beforeView,
      after: entry.plan.afterView,
      beforeBlockOrder: entry.plan.beforeOrder,
      afterBlockOrder: entry.plan.afterOrder,
      idMapping: entry.plan.idMapping,
      warnings: entry.plan.warnings,
    });
  }
  private replay(
    owner: string,
    request: McpStructureAction,
    signature: string,
  ): McpStructureReceipt | undefined {
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner) continue;
      const prior = entry.receipts.get(request.requestId);
      if (!prior) continue;
      if (prior.signature !== signature)
        throw new McpEditError(
          "invalid_edit",
          "Action requestId reused with different input.",
        );
      return {
        ...structuredClone(prior.value),
        status: "already_applied",
        pagesChanged: 0,
        historical: true,
      };
    }
    return undefined;
  }
  async act(
    owner: string,
    input: McpStructureAction,
    direction: McpStructureDirection,
    authorize: () => void,
  ): Promise<McpStructureReceipt> {
    const parsed = McpStructureActionSchema.safeParse(input);
    if (!parsed.success)
      throw new McpEditError("invalid_edit", "Invalid structure action.");
    const request = parsed.data;
    const entry = this.owned(owner, request.editId, authorize);
    const signature = JSON.stringify({ ...request, direction });
    const prior = this.replay(owner, request, signature);
    if (prior) return prior;
    if (entry.busy)
      throw new McpEditError(
        "editor_busy",
        "This edit is being committed. Inspect it before retrying.",
      );
    if (entry.receipts.size >= 32)
      throw new McpEditError(
        "editor_busy",
        "History action limit reached. No changes saved.",
      );
    const expected = { apply: "proposed", undo: "applied", redo: "undone" }[
      direction
    ];
    if (entry.state !== expected)
      throw new McpEditError(
        "invalid_edit",
        "This action does not match the edit state. Inspect availability first.",
      );
    if (request.revision !== entry.expectedRevision)
      throw new McpEditError(
        "revision_conflict",
        "Use the revision from the current edit inspection; do not force a stale change.",
      );
    const claim = this.claimAction(owner, request.requestId, signature);
    entry.busy = true;
    try {
      await this.edits.commitStructure(
        { ...entry.request, revision: request.revision },
        direction === "undo" ? entry.plan.before : entry.plan.after,
        entry.reviewHash,
        () => {
          this.guard(owner, authorize);
          if (this.now() >= entry.expiresAt)
            throw new McpEditError(
              "not_found",
              "Structure edit expired before commit.",
            );
        },
        (page) => this.committed(entry, request, direction, signature, page),
      );
      const receipt = entry.receipts.get(request.requestId);
      if (!receipt)
        throw new Error("Structure commit returned without its receipt.");
      return structuredClone(receipt.value);
    } finally {
      entry.busy = false;
      this.pendingActions.delete(claim);
    }
  }
  private claimAction(owner: string, requestId: string, signature: string) {
    const key = JSON.stringify([owner, requestId]);
    const pending = this.pendingActions.get(key);
    if (pending !== undefined)
      throw new McpEditError(
        pending === signature ? "editor_busy" : "invalid_edit",
        "This requestId is already in flight. Inspect the original edit before retrying.",
      );
    this.pendingActions.set(key, signature);
    return key;
  }
  private committed(
    entry: Entry,
    request: McpStructureAction,
    direction: McpStructureDirection,
    signature: string,
    page: MangaPage,
  ) {
    entry.state = direction === "undo" ? "undone" : "applied";
    entry.expectedRevision = createPageRevision(page);
    entry.expiresAt = this.now() + TTL;
    entry.receipts.set(request.requestId, {
      signature,
      value: {
        editId: entry.id,
        chapterId: entry.request.chapterId,
        pageId: entry.request.pageId,
        requestId: request.requestId,
        direction,
        state: entry.state,
        revision: entry.expectedRevision,
        status: "saved",
        pagesChanged: 1,
        historical: false,
      },
    });
  }
}
