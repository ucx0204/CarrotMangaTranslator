import { lstat } from "node:fs/promises";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import { createPageRevision } from "../../shared/pageRevision";
import { pageContentResource } from "../../shared/appActivityTypes";
import { assertLibraryActivityAccess } from "../library/lock";
import type { InpaintingRevisionChange } from "./inpaintingRevisionHelpers";
import type { InpaintingRevisionRepository } from "./inpaintingRevisionRepository";
import { prepareInpaintingPageRevision } from "./inpaintingRevisionPreparation";

export type SinglePageHistoryTarget = { chapterId: string; pageId: string };
export type SinglePageHistoryState = {
  state: "applied" | "undone" | "conflict" | "unavailable";
  reason: "ready" | "history_unavailable" | "page_changed" | "artifact_missing";
  revision?: PageRevision;
};
export type SinglePageHistoryGuard = SinglePageHistoryTarget & {
  revision: PageRevision;
  assertCanCommit: () => void;
};

/** Called only by the native history owner under its serialized library lock.
 * No model execution, alternate history, text/layout replacement or file delivery. */
export async function inspectSinglePageHistory(
  repository: InpaintingRevisionRepository,
  changes: readonly InpaintingRevisionChange[],
  target: SinglePageHistoryTarget,
): Promise<SinglePageHistoryState> {
  const change = singleImageChange(changes, target);
  if (!change) return { state: "unavailable", reason: "history_unavailable" };
  const chapter = await repository.readChapter(target.chapterId);
  const page = chapter.pages.find((entry) => entry.id === target.pageId);
  if (!page) return { state: "unavailable", reason: "history_unavailable" };
  const revision = createPageRevision(page);
  const direction =
    revision === change.afterRevision
      ? "undo"
      : revision === change.beforeRevision
        ? "redo"
        : undefined;
  if (!direction)
    return { state: "conflict", reason: "page_changed", revision };
  if (!(await artifactsAvailable(change, page.imagePath)))
    return { state: "unavailable", reason: "artifact_missing", revision };
  repository.validateChangePaths(chapter, change);
  prepareInpaintingPageRevision({ chapter, change, direction });
  return {
    state: direction === "undo" ? "applied" : "undone",
    reason: "ready",
    revision,
  };
}

export async function applySinglePageHistory(
  repository: InpaintingRevisionRepository,
  changes: readonly InpaintingRevisionChange[],
  direction: "undo" | "redo",
  guard: SinglePageHistoryGuard,
  retainedPaths: string[],
): Promise<{ revision: PageRevision }> {
  guard.assertCanCommit();
  assertLibraryActivityAccess([
    pageContentResource(guard.chapterId, guard.pageId),
  ]);
  const view = await inspectSinglePageHistory(repository, changes, guard);
  if (
    view.revision !== guard.revision ||
    view.state !== (direction === "undo" ? "applied" : "undone")
  )
    throw new Error(
      "Page history changed or is unavailable. Inspect it again.",
    );
  const chapter = await repository.readChapter(guard.chapterId);
  const prepared = prepareInpaintingPageRevision({
    chapter,
    change: changes[0],
    direction,
  });
  if (createPageRevision(prepared.originalPage) !== guard.revision)
    throw new Error("Page changed before history commit.");
  guard.assertCanCommit();
  // This single chapter/work publication is atomic. Never issue an unguarded
  // compensating write after revocation or an uncertain post-commit response.
  const saved = await repository.savePages(
    guard.chapterId,
    [prepared.nextPage],
    {
      expectedTargets: [
        {
          chapterId: guard.chapterId,
          pageId: guard.pageId,
          revision: guard.revision,
        },
      ],
      retainedInpaintedArtifactPaths: retainedPaths,
    },
    guard.assertCanCommit,
  );
  const page = saved.pages.find((entry) => entry.id === guard.pageId);
  if (!page)
    throw new Error("Saved history page is missing; inspect the library.");
  return { revision: createPageRevision(page) };
}

function singleImageChange(
  changes: readonly InpaintingRevisionChange[],
  target: SinglePageHistoryTarget,
): InpaintingRevisionChange | undefined {
  if (changes.length !== 1) return undefined;
  const change = changes[0];
  if (change.chapterId !== target.chapterId || change.pageId !== target.pageId)
    return undefined;
  if (!distinctRevisions(change) || changesBlocks(change)) return undefined;
  return change;
}
function distinctRevisions(change: InpaintingRevisionChange): boolean {
  return Boolean(
    change.beforeRevision &&
    change.afterRevision &&
    change.beforeRevision !== change.afterRevision,
  );
}
function changesBlocks(change: InpaintingRevisionChange): boolean {
  return Boolean(
    change.beforeBlocks ||
    change.afterBlocks ||
    change.beforeLayout?.length ||
    change.afterLayout?.length,
  );
}
async function artifactsAvailable(
  change: InpaintingRevisionChange,
  original: string,
): Promise<boolean> {
  const paths = new Set([
    original,
    change.beforePath,
    change.afterPath,
    change.beforeMaskPath,
    change.afterMaskPath,
  ]);
  for (const path of paths) {
    if (!path) continue;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size === 0) return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    }
  }
  return true;
}
