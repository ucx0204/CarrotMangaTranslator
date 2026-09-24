import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpResearchBatchPrepare } from "../../shared/mcpResearchBatch";
import {
  McpResearchBatchRecordSchema,
  assertResearchBatchVersion,
  researchHolds,
  type McpResearchBatchRecord,
} from "../application/mcpResearchBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { withLibraryRead, withLibraryMutation } from "../library/lock";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import { MCP_RETENTION_MS } from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

/** Plan records only; native research, content storage and GPU ownership are unchanged. */
export class McpResearchBatchRepository {
  constructor(private readonly storage: McpRetentionStorage) {}
  load(owner: string, id: string) {
    return withLibraryRead(() => this.read(owner, id));
  }
  private async read(owner: string, id: string) {
    const { entry } = await this.storage.owned(owner, id, "research-batch");
    const value = McpResearchBatchRecordSchema.parse(
      await this.storage.record(id),
    );
    if (
      value.owner !== owner ||
      value.id !== id ||
      entry.pageCount !== 0 ||
      value.createdAt !== entry.createdAt ||
      value.expiresAt !== entry.expiresAt ||
      value.input.requestId !== entry.requestId
    )
      throw new McpEditError(
        "invalid_edit",
        "Research plan index and record disagree.",
      );
    return value;
  }
  async find(owner: string, input: McpResearchBatchPrepare) {
    return withLibraryRead(() => this.findUnlocked(owner, input));
  }
  private async findUnlocked(owner: string, input: McpResearchBatchPrepare) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.kind === "research-batch" &&
        item.owner === owner &&
        item.requestId === input.requestId,
    );
    if (!entry) return undefined;
    const value = await this.read(owner, entry.id);
    if (value.inputFingerprint !== hashStableValue(input))
      throw new McpEditError(
        "invalid_edit",
        "Research plan requestId was used for different input.",
      );
    return value;
  }
  async create(
    owner: string,
    input: McpResearchBatchPrepare,
    settingsFingerprint: string,
    guard: () => void,
    verifyUnlocked: () => Promise<void>,
  ) {
    return withLibraryMutation(async () => {
      guard();
      const previous = await this.findUnlocked(owner, input);
      if (previous) return previous;
      await verifyUnlocked();
      const now = this.storage.now();
      const value = McpResearchBatchRecordSchema.parse({
        format: 1,
        id: randomUUID(),
        owner,
        version: 0,
        createdAt: now,
        expiresAt: now + MCP_RETENTION_MS,
        input,
        inputFingerprint: hashStableValue(input),
        settingsFingerprint,
        status: "prepared",
        requests: [],
        works: input.works.map((target) => ({
          target,
          status: researchHolds(target).length ? "held" : "pending",
          attempts: [],
        })),
      });
      await runLibraryTransaction(
        "mcp-research-batch-prepare",
        async (transaction) => {
          await this.storage.stageMetadataRecord(
            transaction,
            {
              id: value.id,
              owner,
              kind: "research-batch",
              operation: "carrot_prepare_research_batch",
              requestId: input.requestId,
              createdAt: now,
              expiresAt: value.expiresAt,
            },
            value,
          );
          transaction.beforePublish(verifyUnlocked);
        },
        undefined,
        guard,
      );
      return value;
    });
  }
  async save(
    value: McpResearchBatchRecord,
    previousVersion: number,
    guard: () => void,
  ) {
    const next = McpResearchBatchRecordSchema.parse(value);
    return withLibraryMutation(async () => {
      guard();
      const current = await this.read(next.owner, next.id);
      assertResearchBatchVersion(current, previousVersion);
      if (
        next.version !== previousVersion + 1 ||
        next.inputFingerprint !== current.inputFingerprint ||
        next.settingsFingerprint !== current.settingsFingerprint ||
        next.createdAt !== current.createdAt ||
        next.expiresAt !== current.expiresAt
      )
        throw new McpEditError(
          "invalid_edit",
          "Invalid research checkpoint transition.",
        );
      await runLibraryTransaction(
        "mcp-research-batch-checkpoint",
        (transaction) => this.storage.stageRecord(transaction, next.id, next),
        undefined,
        guard,
      );
    });
  }
  async list(owner: string) {
    return withLibraryRead(async () => {
      const entries = (await this.storage.index()).entries.filter(
        (entry) =>
          entry.kind === "research-batch" &&
          entry.owner === owner &&
          entry.expiresAt > this.storage.now(),
      );
      entries.sort(
        (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
      );
      return Promise.all(entries.map((entry) => this.read(owner, entry.id)));
    });
  }
  async discard(owner: string, id: string, guard: () => void) {
    return withLibraryMutation(async () => {
      guard();
      const index = await this.storage.index();
      if (
        !index.entries.some(
          (entry) =>
            entry.id === id &&
            entry.owner === owner &&
            entry.kind === "research-batch",
        )
      )
        throw new McpEditError(
          "not_found",
          "Research plan is not owned by this connection.",
        );
      await runLibraryTransaction(
        "mcp-research-batch-discard",
        (transaction) => this.storage.retire(transaction, id, index),
        undefined,
        guard,
      );
      return { id, status: "discarded" as const, pageChanges: 0 as const };
    });
  }
}
