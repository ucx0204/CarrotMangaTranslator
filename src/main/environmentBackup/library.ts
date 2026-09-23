import { assertUniqueIds } from "../libraryStore/libraryJsonValidation";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LibraryChapterFileSchema,
  LibraryWorkFileSchema,
  StoredLibraryIndexFileSchema,
} from "../../shared/ipcSchemas";
import { createPageRevision } from "../../shared/pageRevision";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import { PreparedTranslationCheckpointSchema } from "../pipeline/preparedTranslationCheckpointContract";
import { backupRelativePath, MAX_BACKUP_JSON_BYTES } from "./policy";
import { exists, readBackupJson } from "./files";
import { relocateBackupWorkflow } from "./workflow";

export function portableLibraryPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const marker = normalized.lastIndexOf("/library/works/");
  const relative = marker >= 0 ? normalized.slice(marker + 1) : normalized;
  if (!relative.startsWith("library/works/"))
    throw new Error("A library artifact points outside the library.");
  return backupRelativePath(relative);
}

async function relocateCheckpoint(
  root: string,
  chapterPath: string,
  before: LibraryPageRecord,
  after: LibraryPageRecord,
): Promise<void> {
  const meta = before.translationCheckpoint;
  if (!meta) return;
  const relative = backupRelativePath(meta.artifactPath.replace(/\\/g, "/"));
  if (!/^\.translation-checkpoint-[^/]+\/checkpoint\.json$/.test(relative))
    throw new Error("Invalid checkpoint path.");
  const path = join(root, dirname(chapterPath), relative);
  if ((await lstat(path)).size > MAX_BACKUP_JSON_BYTES)
    throw new Error("Checkpoint document is too large.");
  const original = await readFile(path);
  if (
    original.length !== meta.byteSize ||
    createHash("sha256").update(original).digest("hex") !== meta.sha256
  )
    throw new Error("Checkpoint integrity check failed.");
  const artifact = PreparedTranslationCheckpointSchema.parse(
    JSON.parse(original.toString("utf8")),
  );
  if (
    meta.inputRevision !== artifact.inputRevision ||
    artifact.pageId !== before.id
  )
    throw new Error("Checkpoint binding check failed.");
  // Preserve stale checkpoints as stale; only a valid current binding may be rebound.
  const inputRevision =
    meta.inputRevision === createPageRevision(before)
      ? createPageRevision(after)
      : meta.inputRevision;
  const bytes = Buffer.from(JSON.stringify({ ...artifact, inputRevision }));
  await writeFile(path, bytes);
  after.translationCheckpoint = {
    ...meta,
    artifactPath: relative,
    inputRevision,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function relocatePage(
  root: string,
  chapterPath: string,
  page: LibraryPageRecord,
  destination?: string,
): Promise<LibraryPageRecord> {
  const result = structuredClone(page);
  for (const key of [
    "imagePath",
    "inpaintedImagePath",
    "inpaintMaskPath",
  ] as const) {
    const original = page[key];
    if (!original) continue;
    const path = portableLibraryPath(original);
    if (
      !path.startsWith(`${dirname(chapterPath).replace(/\\/g, "/")}/`) ||
      !(await exists(join(root, path)))
    )
      throw new Error(
        "A required library image is missing or belongs to another chapter.",
      );
    result[key] = destination ? join(destination, path) : path;
  }
  relocateBackupWorkflow(page, result);
  await relocateCheckpoint(root, chapterPath, page, result);
  return result;
}

export async function relocateBackupLibrary(
  root: string,
  files: string[],
  destination?: string,
): Promise<{ works: number; pages: number }> {
  let works = 0;
  let pages = 0;
  const indexPath = join(root, "library/index.json");
  if (!(await exists(indexPath))) {
    if (files.some((path) => path.startsWith("library/works/")))
      throw new Error("Library index is missing.");
    return { works, pages };
  }
  const index = StoredLibraryIndexFileSchema.parse(
    await readBackupJson(indexPath),
  );
  assertUniqueIds(index.workOrder, "Duplicate work ID.");
  for (const id of index.workOrder) {
    backupRelativePath(id);
    if (id.includes("/")) throw new Error("Invalid work ID.");
    const work = LibraryWorkFileSchema.parse(
      await readBackupJson(join(root, "library/works", id, "work.json")),
    );
    if (work.id !== id) throw new Error("Work identity mismatch.");
    assertUniqueIds(work.chapterOrder, "Duplicate chapter ID.");
    works++;
    for (const chapterId of work.chapterOrder) {
      backupRelativePath(chapterId);
      if (chapterId.includes("/")) throw new Error("Invalid chapter ID.");
      const path = `library/works/${id}/chapters/${chapterId}/chapter.json`;
      const chapter = LibraryChapterFileSchema.parse(
        await readBackupJson(join(root, path)),
      );
      if (chapter.id !== chapterId || chapter.workId !== id)
        throw new Error("Chapter identity mismatch.");
      assertUniqueIds(chapter.pageOrder, "Duplicate page order.");
      const ids = chapter.pages.map((page) => page.id);
      assertUniqueIds(ids, "Duplicate page ID.");
      if (chapter.pageOrder.some((id) => !ids.includes(id)))
        throw new Error("Invalid page order.");
      const relocated: LibraryPageRecord[] = [];
      for (const page of chapter.pages)
        relocated.push(await relocatePage(root, path, page, destination));
      pages += relocated.length;
      await writeFile(
        join(root, path),
        JSON.stringify({ ...chapter, pages: relocated }),
      );
    }
  }
  return { works, pages };
}
