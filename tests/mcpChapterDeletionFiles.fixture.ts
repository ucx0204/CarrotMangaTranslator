import type { LibraryTransaction } from "../src/main/libraryStore/libraryTransaction";
import type { ChapterDeletionRecord } from "../src/main/application/mcpChapterDeletionState";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  ChapterDeletionRecordSchema,
  chapterDeletionSnapshot,
} from "../src/main/application/mcpChapterDeletionState";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";

/** Component harness only: does not register a deletion MCP tool or synthesize a retention index entry. */
export async function chapterDeletionFilesFixture(
  recoveryBytes = 2 * 1024 * 1024 + 17,
) {
  const f = await importDuplicateFixture();
  // Load filesystem authorities only AFTER the fixture installs its isolated profile.
  const files = await import("../src/main/mcp/mcpChapterDeletionFiles");
  const native =
    await import("../src/main/libraryStore/libraryChapterDeletion");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { stageWorkFile } =
    await import("../src/main/libraryStore/libraryTransactionFiles");
  const directory = join(
    f.env.libraryDir,
    "works",
    "work",
    "chapters",
    "chapter",
  );
  await mkdir(join(directory, "empty", "nested"), { recursive: true });
  await mkdir(join(directory, "runs", "preserved"), { recursive: true });
  await writeFile(
    join(directory, "runs", "preserved", "large.bin"),
    Buffer.alloc(recoveryBytes, 115),
  );
  await writeFile(
    join(directory, "runs", "preserved", "note.txt"),
    "Private original dialogue and manual scene description 한글",
  );
  await writeFile(join(directory, "empty.bin"), Buffer.alloc(0));
  const target = { workId: "work", chapterId: "chapter" };
  const source = await native.prepareChapterDeletionUnlocked(
    target.workId,
    target.chapterId,
  );
  const tree = await files.captureChapterDeletionTree(directory, () => {});
  const original = new Map(
    await Promise.all(
      tree.files.map(
        async (entry) =>
          [entry.path, await readFile(join(directory, entry.path))] as const,
      ),
    ),
  );
  const id = randomUUID();
  const backup = join(f.env.libraryDir, ".mcp-retained", id);
  await mkdir(join(f.env.libraryDir, ".mcp-retained"), { recursive: true });
  const transaction = <T>(
    run: (transaction: LibraryTransaction) => Promise<T>,
  ): Promise<T> =>
    withLibraryMutation(() =>
      runLibraryTransaction("deletion-byte-fixture", run),
    );
  const retain = async (remove = false) => {
    let copied:
      | Awaited<ReturnType<typeof files.retainChapterDeletionFiles>>
      | undefined;
    await transaction(async (tx) => {
      const staged = await tx.createPublishedDirectory(backup);
      copied = await files.retainChapterDeletionFiles(
        f.storage,
        directory,
        staged.stagingDirectory,
        tree,
        () => {},
      );
      if (remove)
        await native.stageChapterDeletionUnlocked(
          tx,
          source.after,
          target.chapterId,
        );
    });
    if (!copied) throw new Error("Missing fixture capture");
    const input = {
      ...target,
      requestId: randomUUID(),
      snapshot: chapterDeletionSnapshot(target, source.work, tree),
      confirm: "delete-chapter-with-seven-day-recovery",
    };
    const record = ChapterDeletionRecordSchema.parse({
      format: 1,
      id,
      owner: "import-owner",
      input,
      signature: hashStableValue(input),
      createdAt: 1,
      expiresAt: 604800001,
      before: source.work,
      after: source.after,
      chapterTitle: source.chapter.title,
      pageCount: source.chapter.pages.length,
      tree,
      parts: copied.parts,
      actions: [],
    });
    return { record, storageBytes: copied.bytes };
  };
  const restore = async (record: ChapterDeletionRecord) =>
    transaction(async (tx) => {
      const staged = await tx.createPublishedDirectory(directory);
      await files.verifyChapterDeletionFiles(
        f.storage,
        record,
        () => {},
        staged.stagingDirectory,
      );
      await stageWorkFile(tx, source.work);
    });
  return {
    ...f,
    files,
    native,
    source,
    tree,
    original,
    directory,
    backup,
    retain,
    restore,
    transaction,
  };
}
