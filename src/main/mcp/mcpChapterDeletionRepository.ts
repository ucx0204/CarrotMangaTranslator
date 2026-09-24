import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpChapterDeletionTarget } from "../../shared/mcpChapterDeletion";
import {
  ChapterDeletionRecordSchema,
  chapterDeletionSnapshot,
  type ChapterDeletionRecord,
} from "../application/mcpChapterDeletionState";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  readChapterFile,
  readWorkFile,
  readIndexFile,
  type WorkFile,
} from "../libraryStore/libraryFiles";
import {
  getLibraryRoot,
  getWorksRoot,
  getWorkFilePath,
} from "../libraryStore/libraryPaths";
import {
  assertPathWithinRootWithoutSymlinks,
  pathState,
} from "../libraryStore/libraryTransactionStorage";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import {
  captureChapterDeletionTree,
  retainChapterDeletionFiles,
  validateChapterDeletionTree,
  verifyChapterDeletionFiles,
} from "./mcpChapterDeletionFiles";
import { inspectRetainedFile } from "./mcpRetentionEvidence";
import { MCP_RETENTION_MS } from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

type Record = ChapterDeletionRecord;
type Input = Record["input"];

export function chapterDeletionDirectory(target: McpChapterDeletionTarget) {
  return join(getWorksRoot(), target.workId, "chapters", target.chapterId);
}

/** Native locks are owned by the caller. No public input contains a file path. */
export async function readChapterDeletionState(
  target: McpChapterDeletionTarget,
  guard: () => void,
) {
  guard();
  await assertPathWithinRootWithoutSymlinks(
    getLibraryRoot(),
    getWorkFilePath(target.workId),
  );
  const work = await readWorkFile(target.workId);
  if (!work || !(await readIndexFile()).workOrder.includes(work.id))
    throw new McpEditError(
      "not_found",
      "Original work is unavailable; recovery never recreates a work.",
    );
  const directory = chapterDeletionDirectory(target);
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), directory, {
    allowMissingTarget: true,
  });
  const state = await pathState(directory);
  const member = work.chapterOrder.includes(target.chapterId);
  if ((!member && state !== "missing") || (member && state !== "directory"))
    throw new McpEditError(
      "revision_conflict",
      "Chapter membership and directory presence disagree; no overwrite or cleanup.",
    );
  const tree = member
    ? await captureChapterDeletionTree(directory, guard)
    : null;
  const chapter = await readCapturedChapter(target, tree);
  guard();
  return {
    work,
    chapter,
    tree,
    snapshot: chapterDeletionSnapshot(target, work, tree),
  };
}

export class McpChapterDeletionRepository {
  constructor(readonly storage: McpRetentionStorage) {}
  async load(owner: string, id: string): Promise<Record> {
    const { entry } = await this.storage.owned(owner, id, "chapter-deletion");
    const record = ChapterDeletionRecordSchema.parse(
      await this.storage.record(id),
    );
    validateChapterDeletionTree(record.tree);
    if (
      record.id !== id ||
      record.owner !== owner ||
      record.input.requestId !== entry.requestId ||
      record.createdAt !== entry.createdAt ||
      record.expiresAt !== entry.expiresAt ||
      entry.operation !== "carrot_delete_chapter" ||
      entry.pageCount !== record.pageCount ||
      entry.mimeType !== null ||
      entry.sha256 !== null ||
      record.expiresAt - record.createdAt !== MCP_RETENTION_MS
    )
      throw new McpEditError(
        "invalid_edit",
        "Chapter deletion record and index disagree.",
      );
    return record;
  }
  async find(owner: string, input: Input) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.kind === "chapter-deletion" &&
        item.owner === owner &&
        item.requestId === input.requestId,
    );
    if (!entry) return undefined;
    const record = await this.load(owner, entry.id);
    if (record.signature !== hashStableValue(input))
      throw new McpEditError(
        "invalid_edit",
        "Request ID belongs to another chapter deletion.",
      );
    return record;
  }
  assertLive(record: Record) {
    if (record.expiresAt <= this.storage.now())
      throw new McpEditError(
        "not_found",
        "Chapter recovery expired before publication.",
      );
  }
  async publish(
    transaction: LibraryTransaction,
    owner: string,
    input: Input,
    state: Awaited<ReturnType<typeof readChapterDeletionState>>,
    after: WorkFile,
    guard: () => void,
  ) {
    if (!state.tree || !state.chapter)
      throw new Error("Missing chapter deletion source.");
    const createdAt = this.storage.now();
    const id = randomUUID();
    const index = await this.storage.prune(
      transaction,
      await this.storage.index(),
    );
    const directory = await this.storage.create(transaction, id);
    const retained = await retainChapterDeletionFiles(
      this.storage,
      chapterDeletionDirectory(input),
      directory.stagingDirectory,
      state.tree,
      guard,
    );
    const record = ChapterDeletionRecordSchema.parse({
      format: 1,
      id,
      owner,
      input,
      signature: hashStableValue(input),
      createdAt,
      expiresAt: createdAt + MCP_RETENTION_MS,
      before: state.work,
      after,
      chapterTitle: state.chapter.title,
      pageCount: state.chapter.pages.length,
      tree: state.tree,
      parts: retained.parts,
      actions: [],
    });
    // Verify the encrypted staged copy, not just the original, before any source retirement.
    await verifyChapterDeletionFiles(
      this.storage,
      record,
      guard,
      undefined,
      directory.stagingDirectory,
    );
    const metadataBytes = await this.storage.writeRecord(
      directory.stagingDirectory,
      record,
    );
    index.entries.push({
      id,
      owner,
      kind: "chapter-deletion",
      operation: "carrot_delete_chapter",
      requestId: input.requestId,
      createdAt,
      expiresAt: record.expiresAt,
      bytes: retained.bytes + metadataBytes,
      pageCount: record.pageCount,
      mimeType: null,
      sha256: null,
    });
    await this.storage.stageIndex(transaction, index);
    transaction.beforePublish(async () => {
      guard();
      await this.storage.verifyRecord(directory.stagingDirectory, record);
      await verifyChapterDeletionFiles(
        this.storage,
        record,
        guard,
        undefined,
        directory.stagingDirectory,
      );
      this.assertLive(record);
    });
    return record;
  }
  async save(transaction: LibraryTransaction, record: Record) {
    this.assertLive(record);
    await this.storage.stageRecord(
      transaction,
      record.id,
      ChapterDeletionRecordSchema.parse(record),
    );
    transaction.beforePublish(async () => this.assertLive(record));
  }
}

/** Bind parsed chapter metadata to the captured byte inventory. */
async function readCapturedChapter(
  target: McpChapterDeletionTarget,
  tree: Record["tree"] | null,
) {
  if (!tree) return null;
  const directory = chapterDeletionDirectory(target);
  const chapter = await readChapterFile(target.workId, target.chapterId);
  if (!chapter || chapter.pages.length > 50)
    throw new McpEditError(
      "invalid_edit",
      "Available chapter metadata with at most fifty pages is required.",
    );
  if (tree) {
    const metadata = await inspectRetainedFile(join(directory, "chapter.json"));
    const captured = tree.files.find((file) => file.path === "chapter.json");
    if (
      metadata.sha256 !== captured?.sha256 ||
      metadata.bytes !== captured.bytes
    )
      throw new McpEditError(
        "revision_conflict",
        "Chapter metadata changed during capture.",
      );
  }
  return chapter;
}
