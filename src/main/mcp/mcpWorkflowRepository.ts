import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpWorkflowPrepare } from "../../shared/mcpWorkflow";
import type { McpWorkflowHandoffAccept } from "../../shared/mcpWorkflowHandoff";
import {
  assertWorkflowHandoffReady,
  workflowHandoffFingerprint,
} from "../application/mcpWorkflowHandoffService";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  McpWorkflowRecordSchema,
  workflowSteps,
  assertWorkflowVersion,
  type McpWorkflowRecord,
} from "../application/mcpWorkflowPolicy";
import { withLibraryMutation, withLibraryRead } from "../library/lock";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import { MCP_RETENTION_MS } from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

/** Upper-level checkpoints share existing encryption, quotas and native publication. */
export class McpWorkflowRepository {
  constructor(private readonly storage: McpRetentionStorage) {}
  async load(owner: string, id: string): Promise<McpWorkflowRecord> {
    return withLibraryRead(() => this.read(owner, id));
  }
  private async read(owner: string, id: string): Promise<McpWorkflowRecord> {
    const { entry } = await this.storage.owned(owner, id, "workflow");
    const record = McpWorkflowRecordSchema.parse(await this.storage.record(id));
    if (
      record.owner !== owner ||
      record.id !== id ||
      record.pages.length !== entry.pageCount ||
      record.createdAt !== entry.createdAt ||
      record.expiresAt !== entry.expiresAt
    )
      throw new McpEditError(
        "invalid_edit",
        "Workflow metadata is inconsistent.",
      );
    return record;
  }
  async find(owner: string, input: McpWorkflowPrepare) {
    return withLibraryRead(async () => {
      const entry = (await this.storage.index()).entries.find(
        (entry) =>
          entry.kind === "workflow" &&
          entry.owner === owner &&
          entry.requestId === input.requestId,
      );
      if (!entry) return undefined;
      const record = await this.read(owner, entry.id);
      if (record.inputFingerprint !== hashStableValue(input))
        throw new McpEditError(
          "invalid_edit",
          "Workflow requestId was used for different targets or stages.",
        );
      return record;
    });
  }
  async create(
    owner: string,
    input: McpWorkflowPrepare,
    pages: McpWorkflowRecord["pages"],
    settingsFingerprint: string,
    guard: () => void,
  ) {
    return withLibraryMutation(async () => {
      const existing = (await this.storage.index()).entries.find(
        (entry) =>
          entry.kind === "workflow" &&
          entry.owner === owner &&
          entry.requestId === input.requestId,
      );
      if (existing) {
        const record = await this.read(owner, existing.id);
        if (record.inputFingerprint !== hashStableValue(input))
          throw new McpEditError(
            "invalid_edit",
            "Workflow requestId collision.",
          );
        return record;
      }
      const now = this.storage.now();
      const record = McpWorkflowRecordSchema.parse({
        format: 1,
        id: randomUUID(),
        owner,
        version: 0,
        createdAt: now,
        expiresAt: now + MCP_RETENTION_MS,
        input,
        inputFingerprint: hashStableValue(input),
        settingsFingerprint,
        pages,
        steps: workflowSteps(input, pages),
        status: "prepared",
        lastError: null,
        pageAttemptsUsed: 0,
        translationRequestsReserved: 0,
        requests: [],
      });
      await runLibraryTransaction(
        "mcp-workflow-prepare",
        async (transaction) => {
          const index = await this.storage.prune(
            transaction,
            await this.storage.index(),
          );
          const directory = await this.storage.create(transaction, record.id);
          const bytes = await this.storage.writeRecord(
            directory.stagingDirectory,
            record,
          );
          index.entries.push({
            id: record.id,
            owner,
            kind: "workflow",
            operation: "carrot_prepare_workflow",
            requestId: input.requestId,
            createdAt: now,
            expiresAt: record.expiresAt,
            bytes,
            pageCount: pages.length,
            mimeType: null,
            sha256: null,
          });
          await this.storage.stageIndex(transaction, index);
        },
        undefined,
        guard,
      );
      return record;
    });
  }
  async save(record: McpWorkflowRecord, previousVersion: number) {
    const parsed = McpWorkflowRecordSchema.parse(record);
    return withLibraryMutation(async () => {
      const current = await this.read(parsed.owner, parsed.id);
      assertWorkflowVersion(current, previousVersion);
      if (
        parsed.version !== previousVersion + 1 ||
        current.inputFingerprint !== parsed.inputFingerprint
      )
        throw new McpEditError(
          "invalid_edit",
          "Invalid workflow checkpoint transition.",
        );
      await runLibraryTransaction("mcp-workflow-checkpoint", (transaction) =>
        this.storage.stageRecord(transaction, parsed.id, parsed),
      );
    });
  }
  /** Called only after live two-party acceptance under settled session admission. */
  async transfer(
    record: McpWorkflowRecord,
    recipient: string,
    input: McpWorkflowHandoffAccept,
    guard: () => void,
    verify: () => Promise<void>,
  ): Promise<McpWorkflowRecord> {
    return withLibraryMutation(async () => {
      guard();
      const current = await this.read(record.owner, record.id);
      assertWorkflowVersion(current, record.version);
      assertWorkflowVersion(current, input.version);
      assertWorkflowHandoffReady(current);
      if (input.id !== current.id || recipient === current.owner)
        throw new McpEditError("invalid_edit", "Invalid workflow recipient or target.");
      await verify();
      const next = McpWorkflowRecordSchema.parse({
        ...current,
        owner: recipient,
        version: current.version + 1,
        status: current.status === "waiting_external" ? "waiting_external" : "paused",
        lastError: null,
        requests: [{
          requestId: input.requestId,
          fingerprint: workflowHandoffFingerprint(recipient, input),
        }],
        steps: current.steps.map((step) => ({
          ...step,
          attemptId: null,
          jobId: null,
          changeId: null,
          outputId: null,
        })),
      });
      await runLibraryTransaction(
        "mcp-workflow-handoff",
        async (transaction) => {
          await this.storage.stageRecord(transaction, next.id, next, {
            expected: current.owner,
            next: recipient,
          });
          transaction.beforePublish(verify);
        },
        undefined,
        guard,
      );
      return next;
    });
  }
  async list(owner: string) {
    return withLibraryRead(async () => {
      const entries = (await this.storage.index()).entries.filter(
        (entry) =>
          entry.kind === "workflow" &&
          entry.owner === owner &&
          entry.expiresAt > this.storage.now(),
      );
      return Promise.all(
        entries
          .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
          .map((entry) => this.read(owner, entry.id)),
      );
    });
  }
  async discard(owner: string, id: string, guard: () => void) {
    return withLibraryMutation(async () => {
      const { index } = await this.storage.owned(owner, id, "workflow");
      await runLibraryTransaction(
        "mcp-workflow-discard",
        async (transaction) => {
          await this.storage.retire(transaction, id);
          await this.storage.stageIndex(transaction, {
            ...index,
            entries: index.entries.filter((entry) => entry.id !== id),
          });
        },
        undefined,
        guard,
      );
      return { id, status: "discarded" as const, pageChanges: 0 as const };
    });
  }
}
