import {
  createContextProposal,
  selectContextProposal,
  buildContextProposalCommit,
  type ContextProposalEntry as Entry,
} from "./mcpContextProposalPolicy";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpContextApplySchema,
  McpContextInspectSchema,
  McpContextPreviewSchema,
  McpExternalResearchSchema,
  mcpContextOutputSchemas,
  type McpContextChangeSummary,
  type McpContextPreview,
} from "../../shared/mcpContextEditing";
import { type McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";
import type { McpResearchPreparation } from "./mcpResearchProposalState";
import type {
  WorkStyleGuide,
  ChapterStoryMemory,
} from "../../shared/workContextTypes";
import type { z } from "zod/v4";

type Receipt = z.infer<
  typeof mcpContextOutputSchemas.carrot_apply_context_proposal
>;
type Metadata = z.infer<
  typeof mcpContextOutputSchemas.carrot_preview_context_edit
>;
export type McpContextResearchRetention = {
  prepare: (
    owner: string,
    input: McpResearchPreparation,
    guard: () => void,
  ) => Promise<Metadata>;
  inspect: (
    owner: string,
    input: z.infer<typeof McpContextInspectSchema>,
    guard: () => void,
  ) => Promise<
    | z.infer<typeof mcpContextOutputSchemas.carrot_get_context_proposal>
    | undefined
  >;
  apply: (
    owner: string,
    input: z.infer<typeof McpContextApplySchema>,
    guard: () => void,
  ) => Promise<Receipt | undefined>;
};
type ResearchDetails = Pick<McpResearchPreparation, "research">;
type Ports = {
  retained?: McpContextResearchRetention;
  read: (chapterId: string) => Promise<McpContextSnapshot>;
  commit: (
    chapterId: string,
    transform: (current: McpContextSnapshot) => {
      styleGuide?: WorkStyleGuide;
      storyMemory?: ChapterStoryMemory;
      result: Receipt;
    },
    guard: () => void,
  ) => Promise<Receipt>;
  withEdit: (
    snapshot: { chapterId: string; workId: string },
    request: McpContextPreview,
    signal: AbortSignal,
    guard: () => void,
    run: () => Promise<Receipt>,
  ) => Promise<Receipt>;
};
const TTL = 30 * 60_000;
const CAPACITY = 128;

/** Manual previews stay session-local. Research can use the native retained
 * backend; neither route bypasses ownership, reviewed results or atomic writes. */
export class McpContextProposalService {
  private readonly entries = new Map<string, Entry>();
  private readonly receipts = new Map<
    string,
    { fingerprint: string; receipt: Receipt; expiresAt: number }
  >();
  private readonly stopping = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly ports: Ports,
    private readonly now = Date.now,
  ) {}

  preview(owner: string, input: unknown, guard: () => void) {
    return this.enqueue(() =>
      this.prepare(
        owner,
        McpContextPreviewSchema.parse(input),
        "edit",
        [],
        [],
        guard,
      ),
    );
  }
  previewResearch(owner: string, input: unknown, guard: () => void) {
    const parsed = McpExternalResearchSchema.parse(input);
    return this.enqueue(() =>
      this.prepare(
        owner,
        { ...parsed, changes: parsed.changes.map((item) => item.change) },
        "external-research",
        parsed.changes.map((item) => ({
          changeId: item.change.changeId,
          reason: item.reason,
          sources: item.sources,
        })),
        [
          "External sources are caller-supplied, not fetched or verified by this server. Research is not page-read memory.",
        ],
        guard,
      ),
    );
  }
  previewAppResearch(
    owner: string,
    input: McpContextPreview,
    evidence: Array<
      Pick<McpContextChangeSummary, "changeId" | "reason" | "sources">
    >,
    warnings: string[],
    guard: () => void,
    details?: ResearchDetails,
  ) {
    return this.enqueue(() =>
      this.prepare(
        owner,
        McpContextPreviewSchema.parse(input),
        "app-research",
        evidence,
        warnings,
        guard,
        details,
      ),
    );
  }
  inspect(owner: string, input: unknown, guard: () => void) {
    this.check(guard);
    const { proposalId, offset, limit } = McpContextInspectSchema.parse(input);
    const entry = this.owned(owner, proposalId);
    return structuredClone({
      ...entry.metadata,
      total: entry.changes.length,
      offset,
      limit,
      nextOffset: offset + limit < entry.changes.length ? offset + limit : null,
      changes: entry.changes.slice(offset, offset + limit),
    });
  }
  async inspectAvailable(owner: string, input: unknown, guard: () => void) {
    this.check(guard);
    const request = McpContextInspectSchema.parse(input);
    const retained = await this.ports.retained?.inspect(owner, request, () =>
      this.check(guard),
    );
    this.check(guard);
    return retained ?? this.inspect(owner, request, guard);
  }
  apply(owner: string, input: unknown, guard: () => void): Promise<Receipt> {
    const request = McpContextApplySchema.parse(input);
    return this.enqueue(() => this.applySelected(owner, request, guard));
  }
  stop(): void {
    this.stopping.abort();
  }
  async close(): Promise<void> {
    this.stop();
    await this.queue;
    this.entries.clear();
    this.receipts.clear();
  }

  private async prepare(
    owner: string,
    request: McpContextPreview,
    source: Metadata["source"],
    evidence: Array<
      Pick<McpContextChangeSummary, "changeId" | "reason" | "sources">
    >,
    warnings: string[],
    guard: () => void,
    details?: ResearchDetails,
  ) {
    this.check(guard);
    if (source !== "edit" && this.ports.retained)
      return this.ports.retained.prepare(
        owner,
        { request, source, evidence, warnings, ...details },
        () => this.check(guard),
      );
    this.prune();
    const fingerprint = hashStableValue({
      request,
      source,
      evidence,
      warnings,
    });
    const previous = [...this.entries.values()].find(
      (entry) =>
        entry.owner === owner && entry.request.requestId === request.requestId,
    );
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new McpEditError(
          "invalid_edit",
          "requestId belongs to a different context proposal.",
        );
      return structuredClone(previous.metadata);
    }
    if (this.entries.size >= CAPACITY)
      throw new McpEditError(
        "editor_busy",
        "Context proposal capacity reached; wait for expiry.",
      );
    const snapshot = await this.ports.read(request.chapterId);
    this.check(guard);
    const entry = createContextProposal(
      snapshot,
      owner,
      request,
      source,
      evidence,
      warnings,
      fingerprint,
      this.now(),
      TTL,
    );
    this.entries.set(entry.metadata.proposalId, entry);
    return structuredClone(entry.metadata);
  }

  private async applySelected(
    owner: string,
    request: z.infer<typeof McpContextApplySchema>,
    guard: () => void,
  ): Promise<Receipt> {
    this.check(guard);
    const retained = await this.ports.retained?.apply(owner, request, () =>
      this.check(guard),
    );
    this.check(guard);
    if (retained) return retained;
    this.prune();
    const key = JSON.stringify([owner, request.requestId]);
    const fingerprint = hashStableValue(request);
    const cached = this.receipts.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        throw new McpEditError(
          "invalid_edit",
          "requestId belongs to a different application.",
        );
      return { ...structuredClone(cached.receipt), status: "already_applied" };
    }
    if (this.receipts.size >= 512)
      throw new McpEditError(
        "editor_busy",
        "Application receipt capacity reached; wait for expiry.",
      );
    const entry = this.owned(owner, request.proposalId);
    const subset = selectContextProposal(entry, request);
    const check = () => {
      this.check(guard);
      this.owned(owner, request.proposalId);
    };
    const receipt = await this.ports.withEdit(
      entry.metadata,
      subset,
      this.stopping.signal,
      check,
      () =>
        this.ports.commit(
          entry.request.chapterId,
          (current) =>
            buildContextProposalCommit(
              current,
              entry,
              subset,
              request,
              this.now(),
              check,
            ),
          check,
        ),
    );
    entry.applied = receipt;
    this.receipts.set(key, {
      fingerprint,
      receipt: structuredClone(receipt),
      expiresAt: this.now() + TTL,
    });
    return receipt;
  }
  private check(guard: () => void): void {
    this.stopping.signal.throwIfAborted();
    guard();
  }
  private owned(owner: string, id: string): Entry {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.owner !== owner ||
      entry.metadata.expiresAt <= this.now()
    )
      throw new McpEditError(
        "not_found",
        "Context proposal is missing, expired or belongs to another connection. Create a new preview.",
      );
    return entry;
  }
  private prune(): void {
    for (const [key, value] of this.entries)
      if (value.metadata.expiresAt <= this.now()) this.entries.delete(key);
    for (const [key, value] of this.receipts)
      if (value.expiresAt <= this.now()) this.receipts.delete(key);
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(run);
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
