import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpChapterMoveApply } from "../../shared/mcpChapterMove";
import {
  ChapterMoveRecordSchema,
  type ChapterMoveRecord,
} from "../application/mcpChapterMoveState";
import { McpEditError } from "../application/mcpEditPolicy";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import { MCP_RETENTION_MS } from "./mcpRetentionRecords";
import { chapterDeletionDirectory } from "./mcpChapterDeletionRepository";
import {
  retainChapterDeletionFiles,
  verifyChapterDeletionFiles,
} from "./mcpChapterDeletionFiles";
import { validateChapterMoveContent } from "./mcpChapterMoveFiles";
import type { prepareChapterMove } from "./mcpChapterMovePreparation";

type Plan = Awaited<ReturnType<typeof prepareChapterMove>>;

/** Uses the existing profile codec, retention quota and native publication lock. */
export class McpChapterMoveRepository {
  constructor(readonly storage: McpRetentionStorage) {}
  async load(owner: string, id: string): Promise<ChapterMoveRecord> {
    const { entry } = await this.storage.owned(owner, id, "chapter-move");
    const record = ChapterMoveRecordSchema.parse(await this.storage.record(id));
    validateChapterMoveContent(record);
    if (
      record.id !== id ||
      record.owner !== owner ||
      entry.requestId !== record.input.requestId ||
      entry.createdAt !== record.createdAt ||
      entry.expiresAt !== record.expiresAt ||
      entry.operation !== "carrot_move_chapter" ||
      entry.pageCount !== record.afterChapter.pages.length ||
      entry.mimeType !== null ||
      entry.sha256 !== null ||
      record.expiresAt - record.createdAt !== MCP_RETENTION_MS
    )
      throw new McpEditError(
        "invalid_edit",
        "Movement record and retained catalog disagree.",
      );
    return record;
  }
  async find(owner: string, input: McpChapterMoveApply) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.kind === "chapter-move" &&
        item.owner === owner &&
        item.requestId === input.requestId,
    );
    if (!entry) return undefined;
    const record = await this.load(owner, entry.id);
    if (record.signature !== hashStableValue(input))
      throw new McpEditError(
        "invalid_edit",
        "Request ID belongs to another movement.",
      );
    return record;
  }
  assertLive(record: ChapterMoveRecord) {
    if (record.expiresAt <= this.storage.now())
      throw new McpEditError(
        "not_found",
        "Movement recovery expired before publication.",
      );
  }
  async publish(
    transaction: LibraryTransaction,
    owner: string,
    input: McpChapterMoveApply,
    plan: Plan,
    guard: () => void,
  ) {
    const id = randomUUID(),
      createdAt = this.storage.now();
    const index = await this.storage.prune(
      transaction,
      await this.storage.index(),
    );
    const archive = await this.storage.create(transaction, id);
    const retained = await retainChapterDeletionFiles(
      this.storage,
      chapterDeletionDirectory(input.intent),
      archive.stagingDirectory,
      plan.state.tree,
      guard,
    );
    const record = ChapterMoveRecordSchema.parse({
      format: 1,
      id,
      owner,
      input,
      signature: hashStableValue(input),
      createdAt,
      expiresAt: createdAt + MCP_RETENTION_MS,
      before: plan.state.frame,
      after: plan.after,
      tree: plan.state.tree,
      afterTree: plan.content.tree,
      afterChapter: plan.content.chapter,
      afterMemory: plan.content.memory,
      parts: retained.parts,
      actions: [],
    });
    validateChapterMoveContent(record);
    await verifyChapterDeletionFiles(
      this.storage,
      record,
      guard,
      undefined,
      archive.stagingDirectory,
    );
    const bytes = await this.storage.writeRecord(
      archive.stagingDirectory,
      record,
    );
    index.entries.push({
      id,
      owner,
      kind: "chapter-move",
      operation: "carrot_move_chapter",
      requestId: input.requestId,
      createdAt,
      expiresAt: record.expiresAt,
      bytes: bytes + retained.bytes,
      pageCount: record.afterChapter.pages.length,
      mimeType: null,
      sha256: null,
    });
    await this.storage.stageIndex(transaction, index);
    transaction.beforePublish(async () => {
      guard();
      await this.storage.verifyRecord(archive.stagingDirectory, record);
      await verifyChapterDeletionFiles(
        this.storage,
        record,
        guard,
        undefined,
        archive.stagingDirectory,
      );
      this.assertLive(record);
    });
    return { record, archive: archive.stagingDirectory };
  }
  async save(transaction: LibraryTransaction, record: ChapterMoveRecord) {
    this.assertLive(record);
    await this.storage.stageRecord(
      transaction,
      record.id,
      ChapterMoveRecordSchema.parse(record),
    );
    transaction.beforePublish(async () => this.assertLive(record));
  }
}
