import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpWorkDeletionApply } from "../../shared/mcpWorkDeletion";
import {
  WorkDeletionRecordSchema,
  type WorkDeletionRecord,
} from "../application/mcpWorkDeletionState";
import { McpEditError } from "../application/mcpEditPolicy";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import { MCP_RETENTION_MS } from "./mcpRetentionRecords";
import {
  captureStagedDeletionTree,
  retainChapterDeletionFiles,
  verifyChapterDeletionFiles,
  readRecoveryMetadata,
  validateChapterDeletionTree,
} from "./mcpChapterDeletionFiles";
import {
  inspectWorkDeletionInventory,
  workDeletionDirectory,
  type readWorkDeletionState,
} from "./mcpWorkDeletionEvidence";
import {
  assertDeletionRecoveryLive,
  stageDeletionRecoveryRecord,
} from "./mcpDeletionRecoveryGuard";

/** No second store or encryption implementation: one native transaction and the existing profile codec. */
export class McpWorkDeletionRepository {
  constructor(readonly storage: McpRetentionStorage) {}

  async load(owner: string, id: string) {
    const { entry } = await this.storage.owned(owner, id, "work-deletion");
    const record = WorkDeletionRecordSchema.parse(
      await this.storage.record(id),
    );
    validateChapterDeletionTree(record.tree, "work.json");
    const expected = {
      id: record.id,
      owner: record.owner,
      requestId: record.input.requestId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      operation: "carrot_delete_work",
      pageCount: record.summary.pageCount,
      mimeType: null,
      sha256: null,
    };
    if (
      id !== record.id ||
      owner !== record.owner ||
      Object.entries(expected).some(
        ([key, value]) => entry[key as keyof typeof entry] !== value,
      ) ||
      record.expiresAt - record.createdAt !== MCP_RETENTION_MS
    )
      throw new McpEditError(
        "invalid_edit",
        "Work recovery metadata and retained index disagree.",
      );
    return record;
  }
  async find(owner: string, input: McpWorkDeletionApply) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.kind === "work-deletion" &&
        item.owner === owner &&
        item.requestId === input.requestId,
    );
    if (!entry) return undefined;
    const record = await this.load(owner, entry.id);
    if (record.signature !== hashStableValue(input))
      throw new McpEditError(
        "invalid_edit",
        "Request ID already belongs to a different work deletion.",
      );
    return record;
  }
  assertLive(record: WorkDeletionRecord) {
    assertDeletionRecoveryLive(record, this.storage.now());
  }
  async verify(
    record: WorkDeletionRecord,
    guard: () => void,
    stagedSource?: string,
  ) {
    await verifyChapterDeletionFiles(
      this.storage,
      record,
      guard,
      undefined,
      stagedSource,
      "work.json",
    );
    const summary = await inspectWorkDeletionInventory(
      record.input.workId,
      record.tree,
      (path) =>
        readRecoveryMetadata(this.storage, record, path, guard, stagedSource),
      guard,
    );
    if (hashStableValue(summary) !== hashStableValue(record.summary))
      throw new McpEditError(
        "invalid_edit",
        "Work recovery summaries do not match the verified archived chapters.",
      );
    guard();
    this.assertLive(record);
  }
  async retain(
    transaction: LibraryTransaction,
    owner: string,
    input: McpWorkDeletionApply,
    state: Awaited<ReturnType<typeof readWorkDeletionState>>,
    after: WorkDeletionRecord["after"],
    guard: () => void,
  ) {
    if (!state.tree || !state.summary)
      throw new Error("Missing reviewed work source.");
    const index = await this.storage.prune(
      transaction,
      await this.storage.index(),
    );
    const id = randomUUID(),
      createdAt = this.storage.now();
    const archive = await this.storage.create(transaction, id);
    const copied = await retainChapterDeletionFiles(
      this.storage,
      workDeletionDirectory(input.workId),
      archive.stagingDirectory,
      state.tree,
      guard,
      "work.json",
    );
    const record = WorkDeletionRecordSchema.parse({
      format: 1,
      id,
      owner,
      input,
      signature: hashStableValue(input),
      createdAt,
      expiresAt: createdAt + MCP_RETENTION_MS,
      before: state.index,
      after,
      summary: state.summary,
      tree: state.tree,
      parts: copied.parts,
      actions: [],
    });
    await this.verify(record, guard, archive.stagingDirectory);
    const bytes = await this.storage.writeRecord(
      archive.stagingDirectory,
      record,
    );
    index.entries.push({
      id,
      owner,
      kind: "work-deletion",
      operation: "carrot_delete_work",
      requestId: input.requestId,
      createdAt,
      expiresAt: record.expiresAt,
      bytes: bytes + copied.bytes,
      pageCount: record.summary.pageCount,
      mimeType: null,
      sha256: null,
    });
    await this.storage.stageIndex(transaction, index);
    transaction.beforePublish(async () => {
      await this.storage.verifyRecord(archive.stagingDirectory, record);
      await this.verify(record, guard, archive.stagingDirectory);
    });
    return record;
  }
  async save(transaction: LibraryTransaction, record: WorkDeletionRecord) {
    await stageDeletionRecoveryRecord(
      transaction,
      this.storage,
      WorkDeletionRecordSchema.parse(record),
    );
  }
  async stageRestoration(
    transaction: LibraryTransaction,
    record: WorkDeletionRecord,
    guard: () => void,
  ) {
    const directory = await transaction.createPublishedDirectory(
      workDeletionDirectory(record.input.workId),
    );
    await verifyChapterDeletionFiles(
      this.storage,
      record,
      guard,
      directory.stagingDirectory,
      undefined,
      "work.json",
    );
    const verify = async () => {
      const tree = await captureStagedDeletionTree(
        directory,
        guard,
        "work.json",
      );
      if (hashStableValue(tree) !== hashStableValue(record.tree))
        throw new McpEditError(
          "revision_conflict",
          "Staged restored work differs from its verified source.",
        );
      guard();
    };
    await verify();
    transaction.beforePublish(verify);
  }
}
