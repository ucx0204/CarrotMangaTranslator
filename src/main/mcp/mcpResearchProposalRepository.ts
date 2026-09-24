import type { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  mcpContextOutputSchemas,
  type McpContextInspectSchema,
  type McpContextApplySchema,
} from "../../shared/mcpContextEditing";
import { withLibraryRead, withLibraryMutation } from "../library/lock";
import { readWorkContextReferencesUnlocked } from "../library/libraryContextEditingFacade";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "../libraryStore/libraryTransaction";
import { McpEditError } from "../application/mcpEditPolicy";
import { contextMigrationSnapshot } from "../application/mcpContextMigrationPolicy";
import { createContextProposal } from "../application/mcpContextProposalPolicy";
import { researchContextSnapshot } from "../application/mcpResearchProposalPolicy";
import {
  RetainedResearchProposalSchema,
  type RetainedResearchProposal,
  type McpResearchPreparation,
} from "../application/mcpResearchProposalState";
import { MCP_RETENTION_MS, type RetentionIndex } from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

type Record = RetainedResearchProposal;
type Receipt = z.infer<
  typeof mcpContextOutputSchemas.carrot_apply_context_proposal
>;

/** Private reviews share the native transaction/index, not a second library. */
export class McpResearchProposalRepository {
  constructor(
    readonly storage: McpRetentionStorage,
    private readonly lifetime: AbortSignal,
  ) {}

  check(guard: () => void) {
    this.lifetime.throwIfAborted();
    guard();
  }

  async load(owner: string, id: string): Promise<Record> {
    const { entry } = await this.storage.owned(owner, id, "research-proposal");
    const record = RetainedResearchProposalSchema.parse(
      await this.storage.record(id),
    );
    if (
      record.owner !== owner ||
      record.metadata.proposalId !== id ||
      record.createdAt !== entry.createdAt ||
      record.metadata.expiresAt !== entry.expiresAt ||
      record.request.requestId !== entry.requestId ||
      entry.pageCount !== 0
    )
      throw new McpEditError(
        "invalid_edit",
        "Retained research metadata is inconsistent.",
      );
    this.assertLive(record);
    return record;
  }

  async optional(owner: string, id: string, guard: () => void) {
    this.check(guard);
    return withLibraryRead(async () => {
      const entry = (await this.storage.index()).entries.find(
        (item) => item.id === id && item.kind === "research-proposal",
      );
      if (!entry) return undefined;
      const record = await this.load(owner, id);
      this.check(guard);
      return record;
    });
  }

  async prepare(
    owner: string,
    input: McpResearchPreparation,
    guard: () => void,
  ) {
    this.check(guard);
    return withLibraryMutation(async () => {
      const fingerprint = hashStableValue(input);
      const previous = (await this.storage.index()).entries.find(
        (item) =>
          item.kind === "research-proposal" &&
          item.owner === owner &&
          item.requestId === input.request.requestId,
      );
      if (previous) {
        const record = await this.load(owner, previous.id);
        if (record.fingerprint !== fingerprint)
          throw new McpEditError(
            "invalid_edit",
            "requestId belongs to a different retained research proposal.",
          );
        this.check(guard);
        return structuredClone(record.metadata);
      }
      const graph = await readWorkContextReferencesUnlocked(
        input.request.chapterId,
        guard,
      );
      const referenceSnapshot = contextMigrationSnapshot(
        graph,
        input.request.chapterId,
        guard,
      ).snapshot;
      this.assertResearchEvidence(input, referenceSnapshot);
      const createdAt = this.storage.now();
      const entry = createContextProposal(
        researchContextSnapshot(graph, input.request.chapterId),
        owner,
        input.request,
        input.source,
        input.evidence,
        input.warnings,
        fingerprint,
        createdAt,
        MCP_RETENTION_MS,
      );
      const record = RetainedResearchProposalSchema.parse({
        ...entry,
        options: {
          ...entry.options,
          entryIds: Object.entries(entry.options.entryIds),
        },
        format: 1,
        createdAt,
        referenceSnapshot,
        metadata: { ...entry.metadata, retention: "seven-days" },
        ...(input.research ? { research: input.research } : {}),
      });
      this.check(guard);
      await runLibraryTransaction(
        "mcp-retain-research",
        async (transaction) => {
          await this.publish(transaction, record);
          transaction.beforePublish(() => this.verify(record, guard));
        },
        undefined,
        () => this.check(guard),
      );
      return structuredClone(record.metadata);
    });
  }

  private assertResearchEvidence(
    input: McpResearchPreparation,
    snapshot: string,
  ) {
    const expected = input.research?.referenceSnapshot;
    if (expected !== undefined && expected !== snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Saved work changed before research entered the review queue. No review was retained.",
      );
  }

  private async verify(record: Record, guard: () => void) {
    this.check(guard);
    this.assertLive(record);
    const current = await readWorkContextReferencesUnlocked(
      record.request.chapterId,
      guard,
    );
    if (
      contextMigrationSnapshot(current, record.request.chapterId, guard)
        .snapshot !== record.referenceSnapshot
    )
      throw new McpEditError(
        "revision_conflict",
        "Work changed before research review was retained.",
      );
  }

  async inspect(
    owner: string,
    input: z.infer<typeof McpContextInspectSchema>,
    guard: () => void,
  ) {
    const record = await this.optional(owner, input.proposalId, guard);
    if (!record) return undefined;
    const { offset, limit } = input;
    this.check(guard);
    this.assertLive(record);
    return mcpContextOutputSchemas.carrot_get_context_proposal.parse({
      ...record.metadata,
      total: record.changes.length,
      offset,
      limit,
      nextOffset:
        offset + limit < record.changes.length ? offset + limit : null,
      changes: record.changes.slice(offset, offset + limit),
      ...(record.applied ? { recoveryId: record.applied.recoveryId } : {}),
    });
  }

  async applied(
    transaction: LibraryTransaction,
    index: RetentionIndex,
    expected: Record,
    input: z.infer<typeof McpContextApplySchema>,
    receipt: Receipt,
    recoveryId: string,
    guard: () => void,
  ) {
    this.check(guard);
    const current = await this.load(
      expected.owner,
      expected.metadata.proposalId,
    );
    if (
      current.applied ||
      hashStableValue(current) !== hashStableValue(expected)
    )
      throw new McpEditError(
        "revision_conflict",
        "Research proposal changed or was already applied.",
      );
    const record = RetainedResearchProposalSchema.parse({
      ...current,
      applied: { input, receipt: { ...receipt, recoveryId }, recoveryId },
    });
    await this.storage.stageRecord(
      transaction,
      record.metadata.proposalId,
      record,
      undefined,
      index,
    );
    transaction.beforePublish(async () => {
      this.check(guard);
      this.assertLive(record);
    });
  }

  assertLive(record: Record) {
    if (record.metadata.expiresAt <= this.storage.now())
      throw new McpEditError(
        "not_found",
        "Retained research proposal expired.",
      );
  }

  private async publish(transaction: LibraryTransaction, record: Record) {
    this.assertLive(record);
    const index = await this.storage.prune(
      transaction,
      await this.storage.index(),
    );
    const directory = await this.storage.create(
      transaction,
      record.metadata.proposalId,
    );
    const bytes = await this.storage.writeRecord(
      directory.stagingDirectory,
      record,
    );
    index.entries.push({
      id: record.metadata.proposalId,
      owner: record.owner,
      kind: "research-proposal",
      operation:
        record.metadata.source === "app-research"
          ? "carrot_run_context_research"
          : "carrot_preview_context_research",
      requestId: record.request.requestId,
      createdAt: record.createdAt,
      expiresAt: record.metadata.expiresAt,
      bytes,
      pageCount: 0,
      mimeType: null,
      sha256: null,
    });
    await this.storage.stageIndex(transaction, index);
  }
}
