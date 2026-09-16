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

/** This narrow path cannot replay text/layout or multi-page transactions. The
 * existing revision preparation and atomic library save remain authoritative. */
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
  const direction = revision === change.afterRevision ? "undo"
    : revision === change.beforeRevision ? "redo" : undefined;
  if (!direction) return { state: "conflict", reason: "page_changed", revision };
  repository.validateChangePaths(chapter, change);
  prepareInpaintingPageRevision({ chapter, change, direction });
  if (!(await artifactsAvailable(change, page.imagePath)))
    return { state: "unavailable", reason: "artifact_missing", revision };
  return { state: direction === "undo" ? "applied" : "undone", reason: "ready", revision };
}

export async function applySinglePageHistory(
  repository: InpaintingRevisionRepository,
  changes: readonly InpaintingRevisionChange[],
  direction: "undo" | "redo",
  guard: SinglePageHistoryGuard,
  retainedPaths: string[],
): Promise<{ revision: PageRevision }> {
  guard.assertCanCommit();
  assertLibraryActivityAccess([pageContentResource(guard.chapterId, guard.pageId)]);
  const change = singleImageChange(changes, guard);
  if (!change) throw new Error("Single-page image history is unavailable.");
  const view = await inspectSinglePageHistory(repository, changes, guard);
  if (view.revision !== guard.revision || view.state !== (direction === "undo" ? "applied" : "undone"))
    throw new Error("Page history changed or is no longer applicable. Inspect it again.");
  const chapter = await repository.readChapter(guard.chapterId);
  const prepared = prepareInpaintingPageRevision({ chapter, change, direction });
  if (createPageRevision(prepared.originalPage) !== guard.revision)
    throw new Error("Page changed before history commit.");
  guard.assertCanCommit();
  // A single chapter/work write is already atomic. Do not issue an unguarded
  // compensating save after an authorization failure or uncertain commit result.
  const saved = await repository.savePages(guard.chapterId, [prepared.nextPage], {
    expectedTargets: [{ chapterId: guard.chapterId, pageId: guard.pageId, revision: guard.revision }],
    retainedInpaintedArtifactPaths: retainedPaths,
  }, guard.assertCanCommit);
  const page = saved.pages.find((entry) => entry.id === guard.pageId);
  if (!page) throw new Error("Saved history page is missing; inspect the library.");
  return { revision: createPageRevision(page) };
}

function singleImageChange(
  changes: readonly InpaintingRevisionChange[],
  target: SinglePageHistoryTarget,
): InpaintingRevisionChange | undefined {
  const change = changes[0];
  if (changes.length !== 1 || !change || change.chapterId !== target.chapterId || change.pageId !== target.pageId)
    return undefined;
  if (!change.beforeRevision || !change.afterRevision || change.beforeRevision === change.afterRevision)
    return undefined;
  if (change.beforeBlocks || change.afterBlocks || change.beforeLayout?.length || change.afterLayout?.length)
    return undefined;
  return change;
}

async function artifactsAvailable(change: InpaintingRevisionChange, original: string): Promise<boolean> {
  const paths = new Set([original, change.beforePath, change.afterPath, change.beforeMaskPath, change.afterMaskPath]);
  for (const path of paths) {
    if (!path) continue;
    try {
      if (!(await lstat(path)).isFile()) return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}
