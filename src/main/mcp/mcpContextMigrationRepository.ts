import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  RetainedContextMigrationSchema,
  type RetainedContextMigration,
} from "../../shared/mcpContextMigrationState";
import { McpEditError } from "../application/mcpEditPolicy";
import { contextMigrationDeltaCounts } from "../application/mcpContextMigrationPolicy";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import { MCP_RETENTION_MS, type RetentionIndex } from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

type Record = RetainedContextMigration;
type Direction = "apply" | "undo" | "redo";

/** Call under the existing library read/write lock. No transport accepts these records. */
export class McpContextMigrationRepository {
  constructor(
    readonly storage: McpRetentionStorage,
    private readonly couplePublication?: (
      transaction: LibraryTransaction,
      index: RetentionIndex,
      record: Record,
    ) => Promise<void>,
  ) {}

  async load(owner: string, id: string): Promise<Record> {
    const { entry } = await this.storage.owned(owner, id, "context");
    const record = RetainedContextMigrationSchema.parse(
      await this.storage.record(id),
    );
    if (
      record.id !== id ||
      record.owner !== owner ||
      record.createdAt !== entry.createdAt ||
      record.expiresAt !== entry.expiresAt ||
      record.delta.pages.length !== entry.pageCount ||
      record.requestId !== entry.requestId
    )
      throw new McpEditError(
        "invalid_edit",
        "Retained context metadata is inconsistent.",
      );
    return record;
  }

  async find(owner: string, requestId: string, signature: string) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.kind === "context" &&
        item.owner === owner &&
        item.requestId === requestId,
    );
    if (!entry) return undefined;
    const record = await this.load(owner, entry.id);
    if (record.signature !== signature)
      throw new McpEditError(
        "invalid_edit",
        "Context requestId belongs to another migration.",
      );
    return record;
  }

  create(
    input: Omit<
      Record,
      "format" | "id" | "createdAt" | "expiresAt" | "actions"
    >,
  ): Record {
    const now = this.storage.now();
    return RetainedContextMigrationSchema.parse({
      ...input,
      format: 1,
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + MCP_RETENTION_MS,
      actions: [],
    });
  }

  async publish(transaction: LibraryTransaction, record: Record) {
    this.assertLive(record);
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
      owner: record.owner,
      kind: "context",
      operation: record.operation ?? "carrot_apply_context_migration",
      requestId: record.requestId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      bytes,
      pageCount: record.delta.pages.length,
      mimeType: null,
      sha256: null,
    });
    await this.couplePublication?.(transaction, index, record);
    await this.storage.stageIndex(transaction, index);
    transaction.beforePublish(async () => this.assertLive(record));
  }

  async save(transaction: LibraryTransaction, record: Record) {
    this.assertLive(record);
    await this.storage.stageRecord(
      transaction,
      record.id,
      RetainedContextMigrationSchema.parse(record),
    );
    transaction.beforePublish(async () => this.assertLive(record));
  }

  assertLive(record: Record) {
    if (record.expiresAt <= this.storage.now())
      throw new McpEditError(
        "not_found",
        "Context recovery expired before publication.",
      );
  }
}

export function contextMigrationSignature(
  direction: Direction,
  input: unknown,
) {
  return hashStableValue({ direction, input });
}

export function priorContextMigrationAction(
  record: Record,
  requestId: string,
  signature: string,
) {
  if (requestId === record.requestId)
    throw new McpEditError(
      "invalid_edit",
      "Recovery cannot reuse the original migration requestId.",
    );
  const prior = record.actions.find((action) => action.requestId === requestId);
  if (prior && prior.signature !== signature)
    throw new McpEditError(
      "invalid_edit",
      "Context requestId belongs to another recovery action.",
    );
  return prior;
}

export function contextMigrationState(record: Record) {
  const last = record.actions.at(-1);
  const applied = last?.direction !== "undo";
  const changes = contextMigrationDeltaCounts(record.delta);
  const changed =
    changes.guideChanged || changes.pages > 0 || changes.memories > 0;
  return {
    applied,
    changed,
    room: record.actions.length < 32,
    expected: applied ? record.afterSnapshot : record.beforeSnapshot,
  };
}

export function contextMigrationReceipt(
  record: Record,
  direction: Direction,
  requestId: string,
  referenceSnapshot: string,
  historical = false,
) {
  return {
    id: record.id,
    requestId,
    direction,
    status: historical
      ? ("already_applied" as const)
      : contextMigrationState(record).changed
        ? ("saved" as const)
        : ("unchanged" as const),
    historical,
    referenceSnapshot,
    changes: contextMigrationDeltaCounts(record.delta),
    warnings: historical ? ["historical_receipt_not_current_state"] : [],
  };
}
