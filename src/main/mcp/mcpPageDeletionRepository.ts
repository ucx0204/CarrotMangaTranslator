import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import { LibraryChapterFileSchema } from "../../shared/ipcLibrarySchemas";
import { ChapterStoryMemorySchema } from "../../shared/ipcWorkContextSchemas";
import type { McpPageDeletionApply } from "../../shared/mcpPageDeletion";
import {
  PageDeletionRecordSchema,
  type PageDeletionRecord,
} from "../application/mcpPageDeletionState";
import { McpEditError } from "../application/mcpEditPolicy";
import type { PageDeletionFrame } from "../libraryStore/libraryPageDeletion";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import { chapterDeletionDirectory } from "./mcpChapterDeletionRepository";
import {
  retainChapterDeletionFiles,
  verifyChapterDeletionFiles,
  readRecoveryMetadata,
  validateChapterDeletionTree,
} from "./mcpChapterDeletionFiles";
import {
  pageDeletionAfterTree,
  verifyPageDeletionPlan,
  type readPageDeletionState,
} from "./mcpPageDeletionEvidence";
import { MCP_RETENTION_MS } from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import { assertDeletionRecoveryLive } from "./mcpDeletionRecoveryGuard";

type Record = PageDeletionRecord;

/** No second asset store: originals and page history join the native deletion transaction. */
export class McpPageDeletionRepository {
  constructor(readonly storage: McpRetentionStorage) {}
  async load(owner: string, id: string) {
    const { entry } = await this.storage.owned(owner, id, "page-deletion");
    const record = PageDeletionRecordSchema.parse(
      await this.storage.record(id),
    );
    validateChapterDeletionTree(record.tree);
    validateChapterDeletionTree(record.afterTree);
    verifyPageDeletionPlan(record);
    const expected = {
      id: record.id,
      owner: record.owner,
      requestId: record.input.requestId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      operation: "carrot_delete_page",
      pageCount: 1,
      mimeType: null,
      sha256: null,
    };
    if (
      record.id !== id ||
      record.owner !== owner ||
      record.expiresAt - record.createdAt !== MCP_RETENTION_MS ||
      Object.entries(expected).some(
        ([key, value]) => entry[key as keyof typeof entry] !== value,
      )
    )
      throw new McpEditError(
        "invalid_edit",
        "Page recovery record and retained catalog disagree.",
      );
    return record;
  }
  async find(owner: string, input: McpPageDeletionApply) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.kind === "page-deletion" &&
        item.owner === owner &&
        item.requestId === input.requestId,
    );
    if (!entry) return undefined;
    const record = await this.load(owner, entry.id);
    if (record.signature !== hashStableValue(input))
      throw new McpEditError(
        "invalid_edit",
        "Request ID belongs to a different page deletion.",
      );
    return record;
  }
  assertLive(record: Record) {
    assertDeletionRecoveryLive(record, this.storage.now());
  }
  async verify(record: Record, guard: () => void, staging?: string) {
    await verifyChapterDeletionFiles(
      this.storage,
      record,
      guard,
      undefined,
      staging,
    );
    const chapter = LibraryChapterFileSchema.parse(
      await readRecoveryMetadata(
        this.storage,
        record,
        "chapter.json",
        guard,
        staging,
      ),
    );
    const memory = record.tree.files.some(
      (file) => file.path === "story-memory.json",
    )
      ? ChapterStoryMemorySchema.parse(
          await readRecoveryMetadata(
            this.storage,
            record,
            "story-memory.json",
            guard,
            staging,
          ),
        )
      : null;
    if (
      hashStableValue(chapter) !== hashStableValue(record.before.chapter) ||
      hashStableValue(memory) !== hashStableValue(record.before.memory)
    )
      throw new McpEditError(
        "invalid_edit",
        "Recorded page metadata or memory differs from the verified archive.",
      );
    verifyPageDeletionPlan(record);
    this.assertLive(record);
    guard();
  }
  async publish(
    transaction: LibraryTransaction,
    owner: string,
    input: McpPageDeletionApply,
    state: Awaited<ReturnType<typeof readPageDeletionState>>,
    after: PageDeletionFrame,
    guard: () => void,
  ) {
    const index = await this.storage.prune(
      transaction,
      await this.storage.index(),
    );
    const id = randomUUID(),
      createdAt = this.storage.now();
    const archive = await this.storage.create(transaction, id);
    const assets = await retainChapterDeletionFiles(
      this.storage,
      chapterDeletionDirectory(input),
      archive.stagingDirectory,
      state.tree,
      guard,
    );
    const record = PageDeletionRecordSchema.parse({
      format: 1,
      id,
      owner,
      input,
      signature: hashStableValue(input),
      createdAt,
      expiresAt: createdAt + MCP_RETENTION_MS,
      before: state.frame,
      after,
      tree: state.tree,
      afterTree: pageDeletionAfterTree(input, state.frame, after, state.tree),
      parts: assets.parts,
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
      kind: "page-deletion",
      operation: "carrot_delete_page",
      requestId: input.requestId,
      createdAt,
      expiresAt: record.expiresAt,
      bytes: assets.bytes + bytes,
      pageCount: 1,
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
}
