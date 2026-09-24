import { validateChapterDeletionTree } from "./mcpChapterDeletionFiles";
import { relative, join } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpPageDeletionTarget } from "../../shared/mcpPageDeletion";
import type { PageDeletionRecord } from "../application/mcpPageDeletionState";
import { pageDeletionSnapshot } from "../application/mcpPageDeletionState";
import { McpEditError } from "../application/mcpEditPolicy";
import { getAppPaths } from "../appPaths";
import { LinkedWorkspaceStore } from "../linkedWorkspace/linkedWorkspaceStore";
import { readLibraryPageOrdering } from "../libraryStore/libraryPageOrdering";
import {
  pageDeletionPaths,
  preparePageDeletionFrame,
  type PageDeletionFrame,
} from "../libraryStore/libraryPageDeletion";
import { normalizeShareRelativePath } from "../libraryStore/zipSafety";
import { sha256Bytes } from "../libraryStore/libraryTransactionStorage";
import {
  readChapterDeletionState,
  chapterDeletionDirectory,
} from "./mcpChapterDeletionRepository";
import { inspectRetainedFile } from "./mcpRetentionEvidence";
import type { ChapterDeletionTree } from "../application/mcpChapterDeletionState";

export async function readPageDeletionState(
  target: McpPageDeletionTarget,
  guard: () => void,
) {
  const state = await readChapterDeletionState(target, guard);
  if (!state.chapter || !state.tree)
    throw new McpEditError(
      "not_found",
      "Original chapter is unavailable; page recovery never recreates its chapter.",
    );
  const { memory } = await readLibraryPageOrdering(state.chapter);
  const memoryFile = state.tree.files.find(
    (file) => file.path === "story-memory.json",
  );
  if (Boolean(memoryFile) !== Boolean(memory))
    throw new McpEditError(
      "revision_conflict",
      "Story-memory presence changed during review.",
    );
  if (memoryFile) {
    const actual = await inspectRetainedFile(
      join(chapterDeletionDirectory(target), memoryFile.path),
    );
    if (
      actual.sha256 !== memoryFile.sha256 ||
      actual.bytes !== memoryFile.bytes
    )
      throw new McpEditError(
        "revision_conflict",
        "Story memory changed during review.",
      );
  }
  const registry = await new LinkedWorkspaceStore(
    getAppPaths().dataRoot,
  ).readRegistry();
  if (registry.records.some((entry) => entry.chapterId === target.chapterId))
    throw new McpEditError(
      "invalid_edit",
      "Detach this chapter's linked workspace in the app before page removal or recovery, including disabled links.",
    );
  guard();
  return {
    frame: { work: state.work, chapter: state.chapter, memory },
    tree: state.tree,
    snapshot: pageDeletionSnapshot(target, state.work, state.tree),
  };
}

/** Only captured run directories and native-validated page paths can contribute retirement targets. */
export function pageDeletionRetirements(
  target: McpPageDeletionTarget,
  chapter: PageDeletionFrame["chapter"],
  tree: ChapterDeletionTree,
) {
  const root = chapterDeletionDirectory(target);
  const runs = tree.directories
    .filter((path) =>
      (process.platform === "win32"
        ? /^runs\/[^/]+$/iu
        : /^runs\/[^/]+$/u
      ).test(path),
    )
    .map((path) => path.slice(5));
  const native = pageDeletionPaths(chapter, target.pageId, runs);
  const checked = (path: string) =>
    normalizeShareRelativePath(
      relative(root, path).replace(/\\/gu, "/"),
      "Page deletion path escaped its chapter.",
    );
  const canonical = (paths: string[], inventory: string[]) =>
    paths.flatMap((path) => {
      const selected = checked(path);
      const actual = inventory.find(
        (entry) => relative(join(root, entry), join(root, selected)) === "",
      );
      return actual === undefined ? [] : [actual];
    });
  const files = canonical(
    native.files,
    tree.files.map((file) => file.path),
  );
  const directories = canonical(native.directories, tree.directories);
  if (
    files.some((path) =>
      ["chapter.json", "story-memory.json"].includes(path.toLowerCase()),
    )
  )
    throw new McpEditError(
      "invalid_edit",
      "Page assets overlap chapter metadata.",
    );
  for (const directory of directories)
    validateChapterDeletionTree(
      pageDeletionSubtree(tree, directory).tree,
      null,
    );
  return { files, directories };
}

export function pageDeletionAfterTree(
  target: McpPageDeletionTarget,
  before: PageDeletionFrame,
  after: PageDeletionFrame,
  tree: ChapterDeletionTree,
) {
  const removed = pageDeletionRetirements(target, before.chapter, tree);
  const retired = (path: string) =>
    removed.files.includes(path) ||
    removed.directories.some((parent) => inTree(parent, path));
  const replacements = new Map<string, Buffer>([
    ["chapter.json", jsonBytes(after.chapter)],
  ]);
  if (
    after.memory &&
    hashStableValue(before.memory) !== hashStableValue(after.memory)
  )
    replacements.set("story-memory.json", jsonBytes(after.memory));
  return {
    directories: tree.directories.filter((path) => !retired(path)),
    files: tree.files
      .filter((file) => !retired(file.path))
      .map((file) => {
        const bytes = replacements.get(file.path);
        return bytes
          ? { path: file.path, bytes: bytes.length, sha256: sha256Bytes(bytes) }
          : file;
      }),
  };
}
export function verifyPageDeletionPlan(record: PageDeletionRecord) {
  const after = preparePageDeletionFrame(
    record.before,
    record.input.pageId,
    record.after.chapter.updatedAt,
  );
  if (
    hashStableValue(after) !== hashStableValue(record.after) ||
    hashStableValue(
      pageDeletionAfterTree(record.input, record.before, after, record.tree),
    ) !== hashStableValue(record.afterTree)
  )
    throw new McpEditError(
      "invalid_edit",
      "Retained page deletion does not match the native removal and memory policy.",
    );
}
export function describePageDeletion(
  target: McpPageDeletionTarget,
  before: PageDeletionFrame,
  after: PageDeletionFrame,
  tree: ChapterDeletionTree,
  afterTree: ChapterDeletionTree,
) {
  const page = before.chapter.pages.find((item) => item.id === target.pageId);
  if (!page) throw new McpEditError("not_found", "Page is not present.");
  const removed = tree.files.filter(
    (file) => !afterTree.files.some((next) => next.path === file.path),
  );
  return {
    workId: target.workId,
    chapterId: target.chapterId,
    pageId: target.pageId,
    workTitle: before.work.title,
    chapterTitle: before.chapter.title,
    pageName: page.name,
    pageCount: before.chapter.pages.length,
    remainingPages: after.chapter.pages.length,
    fileCount: tree.files.length,
    directoryCount: tree.directories.length,
    sourceBytes: tree.files.reduce((sum, file) => sum + file.bytes, 0),
    removedFiles: removed.length,
    removedDirectories: tree.directories.length - afterTree.directories.length,
    removedBytes: removed.reduce((sum, file) => sum + file.bytes, 0),
    memoryChanged:
      hashStableValue(before.memory) !== hashStableValue(after.memory),
    memoryRowsBefore: before.memory?.pages.length ?? 0,
    memoryRowsAfter: after.memory?.pages.length ?? 0,
  };
}
function jsonBytes(value: unknown) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}
function inTree(parent: string, path: string) {
  return parent === path || path.startsWith(parent + "/");
}

/** The same native subtree projection is validated before deletion and used for restoration. */
function pageDeletionSubtree(tree: ChapterDeletionTree, path: string) {
  const prefix = path + "/";
  const indexes = tree.files.flatMap((file, index) =>
    file.path.startsWith(prefix) ? [index] : [],
  );
  return {
    indexes,
    tree: {
      directories: tree.directories
        .filter((directory) => directory.startsWith(prefix))
        .map((directory) => directory.slice(prefix.length)),
      files: indexes.map((index) => ({
        ...tree.files[index],
        path: tree.files[index].path.slice(prefix.length),
      })),
    },
  };
}
