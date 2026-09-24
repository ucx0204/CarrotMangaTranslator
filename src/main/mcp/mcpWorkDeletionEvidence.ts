import { dirname, join } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  LibraryWorkFileSchema,
  LibraryChapterFileSchema,
  StoredLibraryIndexFileSchema,
} from "../../shared/ipcLibrarySchemas";
import type { ChapterDeletionTree } from "../application/mcpChapterDeletionState";
import { workDeletionSnapshot } from "../application/mcpWorkDeletionState";
import { McpEditError } from "../application/mcpEditPolicy";
import { getAppPaths } from "../appPaths";
import { LinkedWorkspaceStore } from "../linkedWorkspace/linkedWorkspaceStore";
import {
  getLibraryRoot,
  getLibraryIndexPath,
  getWorkFilePath,
} from "../libraryStore/libraryPaths";
import {
  assertPathWithinRootWithoutSymlinks,
  pathState,
  readBoundedJsonFile,
} from "../libraryStore/libraryTransactionStorage";
import {
  validateChapterFilePaths,
  readIndexFile,
  readWorkFile,
} from "../libraryStore/libraryFiles";
import { captureChapterDeletionTree } from "./mcpChapterDeletionFiles";

export function workDeletionDirectory(workId: string) {
  return dirname(getWorkFilePath(workId));
}

/** Source and decoded backup use the same chapter membership/count validation. */
export async function inspectWorkDeletionInventory(
  workId: string,
  tree: ChapterDeletionTree,
  read: (path: string) => Promise<unknown>,
  guard: () => void,
) {
  const work = LibraryWorkFileSchema.parse(await read("work.json"));
  const ids = work.chapterOrder;
  const directories = tree.directories
    .filter((path) => /^chapters\/[^/]+$/u.test(path))
    .map((path) => path.slice(9));
  if (
    work.id !== workId ||
    ids.length > 10 ||
    new Set(ids).size !== ids.length ||
    hashStableValue([...ids].sort()) !== hashStableValue(directories.sort())
  )
    throw new McpEditError(
      "invalid_edit",
      "Work recovery requires at most ten chapters with exact directory membership.",
    );
  const chapters = [];
  let pageCount = 0;
  for (const chapterId of ids) {
    guard();
    const chapter = validateChapterFilePaths(
      workId,
      chapterId,
      LibraryChapterFileSchema.parse(
        await read(`chapters/${chapterId}/chapter.json`),
      ),
    );
    const pages = chapter.pages.map((page) => page.id);
    pageCount += pages.length;
    if (
      chapter.id !== chapterId ||
      chapter.workId !== workId ||
      pageCount > 50 ||
      new Set(pages).size !== pages.length ||
      new Set(chapter.pageOrder).size !== pages.length ||
      hashStableValue([...pages].sort()) !==
        hashStableValue([...chapter.pageOrder].sort())
    )
      throw new McpEditError(
        "invalid_edit",
        "Work recovery requires an exact inventory of at most fifty pages in total.",
      );
    chapters.push({ chapterId, title: chapter.title, pageCount: pages.length });
  }
  guard();
  return { workTitle: work.title, chapters, pageCount };
}

/** Reads only one captured work. Missing/occupied membership is never repaired by a deletion request. */
export async function readWorkDeletionState(workId: string, guard: () => void) {
  guard();
  const indexPath = getLibraryIndexPath();
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), indexPath);
  const index = StoredLibraryIndexFileSchema.parse(
    await readBoundedJsonFile(indexPath),
  );
  if (
    index.workOrder.length > 2000 ||
    new Set(index.workOrder).size !== index.workOrder.length
  )
    throw new McpEditError(
      "invalid_edit",
      "The library index must contain at most 2000 distinct works.",
    );
  const directory = workDeletionDirectory(workId);
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), directory, {
    allowMissingTarget: true,
  });
  const state = await pathState(directory);
  const present = index.workOrder.includes(workId);
  if (present ? state !== "directory" : state !== "missing")
    throw new McpEditError(
      "revision_conflict",
      "Work directory and library membership disagree; no cleanup or overwrite.",
    );
  const tree = present
    ? await captureChapterDeletionTree(directory, guard, "work.json")
    : null;
  const summary = tree
    ? await inspectWorkDeletionInventory(
        workId,
        tree,
        async (path) => {
          if (!tree.files.some((file) => file.path === path))
            throw new Error("Missing captured work metadata.");
          return readBoundedJsonFile(join(directory, path));
        },
        guard,
      )
    : null;
  guard();
  return {
    index,
    tree,
    summary,
    snapshot: workDeletionSnapshot(workId, index, tree),
  };
}

export async function assertWorkDeletionUnlinked(
  workId: string,
  chapterIds: string[],
  guard: () => void,
) {
  guard();
  const registry = await new LinkedWorkspaceStore(
    getAppPaths().dataRoot,
  ).readRegistry();
  if (
    registry.records.some(
      (record) =>
        record.workId === workId || chapterIds.includes(record.chapterId),
    )
  )
    throw new McpEditError(
      "invalid_edit",
      "Detach this work's linked workspaces in the app first, including disabled links. External folders are never changed.",
    );
  guard();
}

/** Chapter IDs belong to the native library, not merely to a directory being restored. */
export async function assertWorkDeletionChapterIdentities(
  workId: string,
  ids: string[],
  guard: () => void,
) {
  const index = await readIndexFile();
  if (index.workOrder.length > 2000)
    throw new McpEditError(
      "invalid_edit",
      "Library identity scan exceeds 2000 works.",
    );
  for (const otherId of index.workOrder) {
    guard();
    if (otherId === workId || ids.length === 0) continue;
    const work = await readWorkFile(otherId);
    if (!work)
      throw new McpEditError(
        "invalid_edit",
        "Cannot establish chapter identity in an inconsistent library.",
      );
    if (work.chapterOrder.some((id) => ids.includes(id)))
      throw new McpEditError(
        "revision_conflict",
        "A recorded chapter ID now belongs to another work; restoration cannot duplicate its identity.",
      );
  }
  guard();
}
