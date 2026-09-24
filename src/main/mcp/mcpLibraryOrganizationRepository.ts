import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpLibraryOrganizationApply } from "../../shared/mcpLibraryOrganization";
import {
  McpLibraryOrganizationRecordSchema,
  type McpLibraryOrganizationRecord,
} from "../application/mcpLibraryOrganizationState";
import { McpEditError } from "../application/mcpEditPolicy";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import { MCP_RETENTION_MS } from "./mcpRetentionRecords";

type Record = McpLibraryOrganizationRecord;
/** Native locks are owned by the caller. There is no independent metadata store. */
export class McpLibraryOrganizationRepository {
  constructor(readonly storage: McpRetentionStorage) {}
  async load(owner: string, id: string): Promise<Record> {
    const { entry } = await this.storage.owned(owner, id, "library");
    const record = McpLibraryOrganizationRecordSchema.parse(
      await this.storage.record(id),
    );
    if (
      record.id !== id ||
      record.owner !== owner ||
      record.createdAt !== entry.createdAt ||
      record.expiresAt !== entry.expiresAt ||
      record.input.requestId !== entry.requestId ||
      entry.pageCount !== 0 ||
      entry.operation !== "carrot_apply_library_change" ||
      record.expiresAt - record.createdAt !== MCP_RETENTION_MS
    )
      throw new McpEditError(
        "invalid_edit",
        "Retained library metadata is inconsistent.",
      );
    return record;
  }
  async find(owner: string, input: McpLibraryOrganizationApply) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.owner === owner &&
        item.kind === "library" &&
        item.requestId === input.requestId,
    );
    if (!entry) return undefined;
    const record = await this.load(owner, entry.id);
    if (record.signature !== hashStableValue(input))
      throw new McpEditError(
        "invalid_edit",
        "Request ID belongs to another library change.",
      );
    return record;
  }
  create(
    owner: string,
    input: McpLibraryOrganizationApply,
    before: Record["before"],
    after: Record["after"],
  ): Record {
    const now = this.storage.now();
    return McpLibraryOrganizationRecordSchema.parse({
      format: 1,
      id: randomUUID(),
      owner,
      input,
      signature: hashStableValue(input),
      before,
      after,
      createdAt: now,
      expiresAt: now + MCP_RETENTION_MS,
      actions: [],
    });
  }
  assertLive(record: Record) {
    if (record.expiresAt <= this.storage.now())
      throw new McpEditError(
        "not_found",
        "Library recovery record expired before publication.",
      );
  }
  async publish(transaction: LibraryTransaction, record: Record) {
    this.assertLive(record);
    await this.storage.stageMetadataRecord(
      transaction,
      {
        id: record.id,
        owner: record.owner,
        kind: "library",
        operation: "carrot_apply_library_change",
        requestId: record.input.requestId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      },
      McpLibraryOrganizationRecordSchema.parse(record),
    );
    transaction.beforePublish(async () => this.assertLive(record));
  }
  async save(transaction: LibraryTransaction, record: Record) {
    this.assertLive(record);
    await this.storage.stageRecord(
      transaction,
      record.id,
      McpLibraryOrganizationRecordSchema.parse(record),
    );
    transaction.beforePublish(async () => this.assertLive(record));
  }
}
