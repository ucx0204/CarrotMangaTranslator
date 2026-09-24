import { createHash } from "node:crypto";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { LibraryChapter } from "../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import type { McpChapterMoveIntent } from "../../shared/mcpChapterMove";
import type { ChapterDeletionTree } from "../application/mcpChapterDeletionState";
import { planChapterMoveReferences } from "../application/mcpChapterMoveReferences";
import { validateChapterFilePaths } from "../libraryStore/libraryFiles";
import { stripInternalPageArtifacts } from "../libraryStore/translationCheckpointStore";
import { chapterDeletionDirectory } from "./mcpChapterDeletionRepository";

/** Only documented path/reference/ownership fields change. Original IDs and artwork bytes remain. */
export function prepareChapterMoveContent(
  intent: McpChapterMoveIntent,
  chapter: LibraryChapter,
  memory: ChapterStoryMemory | null,
  guides: [WorkStyleGuide, WorkStyleGuide],
  tree: ChapterDeletionTree,
  title: string,
  now: string,
) {
  const result = planChapterMoveReferences(
    chapter,
    memory,
    guides[0],
    guides[1],
    intent.references ?? [],
  );
  const source = chapterDeletionDirectory(intent);
  const destination = chapterDeletionDirectory({
    workId: intent.destinationWorkId,
    chapterId: intent.chapterId,
  });
  const paths = new Set(tree.files.map((file) => file.path));
  const relocate = (path: string) => {
    const child = relative(source, resolve(path));
    if (
      !child ||
      isAbsolute(child) ||
      child.split(/[\\/]/u).includes("..") ||
      !paths.has(child.replaceAll("\\", "/"))
    )
      throw new Error(
        "A referenced page asset is missing or outside the captured chapter.",
      );
    return join(destination, child);
  };
  const pages = result.chapter.pages.map((page) => ({
    ...stripInternalPageArtifacts(page),
    imagePath: relocate(page.imagePath),
    ...(page.inpaintedImagePath
      ? { inpaintedImagePath: relocate(page.inpaintedImagePath) }
      : {}),
    ...(page.inpaintMaskPath
      ? { inpaintMaskPath: relocate(page.inpaintMaskPath) }
      : {}),
  }));
  const moved = validateChapterFilePaths(
    intent.destinationWorkId,
    intent.chapterId,
    {
      ...result.chapter,
      workId: intent.destinationWorkId,
      title,
      pages,
      updatedAt: now,
    },
  );
  const movedMemory = result.memory
    ? { ...result.memory, workId: intent.destinationWorkId }
    : null;
  const replacements = chapterMoveReplacements(moved, movedMemory);
  return {
    chapter: moved,
    memory: movedMemory,
    issues: result.issues,
    mappedReferences: result.mappedReferences,
    invalidatedCheckpoints: chapter.pages.filter(
      (page) => page.translationCheckpoint || page.fontContinuity,
    ).length,
    replacements,
    tree: chapterMoveTree(tree, replacements),
  };
}

/** Fixed native filenames only; no client-supplied destination paths. */
export function chapterMoveReplacements(
  chapter: LibraryChapter,
  memory: ChapterStoryMemory | null,
) {
  const values: Array<[string, unknown]> = [["chapter.json", chapter]];
  if (memory) values.push(["story-memory.json", memory]);
  return new Map(
    values.map(([path, value]) => [
      path,
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    ]),
  );
}
export function chapterMoveTree(
  tree: ChapterDeletionTree,
  replacements: Map<string, Buffer>,
): ChapterDeletionTree {
  if (
    [...replacements.keys()].some(
      (path) => !tree.files.some((file) => file.path === path),
    )
  )
    throw new Error("Movement cannot invent an absent metadata file.");
  return {
    directories: [...tree.directories],
    files: tree.files.map((file) => {
      const bytes = replacements.get(file.path);
      return bytes
        ? {
            path: file.path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }
        : { ...file };
    }),
  };
}
