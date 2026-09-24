import { dirname, join } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import { WorkStyleGuideSchema } from "../../shared/ipcWorkContextSchemas";
import type { WorkStyleGuide } from "../../shared/workContextTypes";
import type { McpChapterMoveIntent } from "../../shared/mcpChapterMove";
import {
  chapterMoveSnapshot,
  type ChapterMoveFrame,
} from "../application/mcpChapterMoveState";
import { McpEditError } from "../application/mcpEditPolicy";
import { getAppPaths } from "../appPaths";
import { LinkedWorkspaceStore } from "../linkedWorkspace/linkedWorkspaceStore";
import { collectUsedChapterTitles } from "../libraryStore/libraryFiles";
import { getLibraryRoot, getWorkFilePath } from "../libraryStore/libraryPaths";
import { readWorkStyleGuide } from "../libraryStore/workContextFiles";
import {
  assertPathWithinRootWithoutSymlinks,
  pathState,
  readBoundedJsonFile,
} from "../libraryStore/libraryTransactionStorage";
import { readChapterDeletionState } from "./mcpChapterDeletionRepository";
import { inspectRetainedFile } from "./mcpRetentionEvidence";

/** Both locations and existing context authorities are read under the caller's library boundary. */
export async function readChapterMoveState(
  intent: McpChapterMoveIntent,
  guard: () => void,
) {
  guard();
  const registry = await new LinkedWorkspaceStore(
    getAppPaths().dataRoot,
  ).readRegistry();
  if (registry.records.some((item) => item.chapterId === intent.chapterId))
    throw new McpEditError(
      "invalid_edit",
      "Detach this chapter's linked workspace in the app before moving it. Existing mirror destinations are never silently changed.",
    );
  const left = await readChapterDeletionState(intent, guard);
  const right = await readChapterDeletionState(
    { workId: intent.destinationWorkId, chapterId: intent.chapterId },
    guard,
  );
  if (Boolean(left.tree) === Boolean(right.tree))
    throw new McpEditError(
      "revision_conflict",
      "Exactly one of the two existing works must own this chapter.",
    );
  if (
    left.work.chapterOrder.length > 2000 ||
    right.work.chapterOrder.length > 2000
  )
    throw new McpEditError(
      "invalid_edit",
      "Work chapter inventory exceeds 2000 entries.",
    );
  const guides = await Promise.all([
    readGuide(intent.workId),
    readGuide(intent.destinationWorkId),
  ]);
  const siblings = await Promise.all(
    [intent.workId, intent.destinationWorkId].map(async (id) =>
      hashStableValue(
        [...(await collectUsedChapterTitles(id, intent.chapterId))].sort(),
      ),
    ),
  );
  const frame: ChapterMoveFrame = {
    works: [left.work, right.work],
    guides: [guides[0].version, guides[1].version],
    siblings: [siblings[0], siblings[1]],
  };
  const tree = left.tree ?? right.tree;
  if (!tree) throw new Error("Missing movement inventory.");
  const moved = right.tree !== null;
  guard();
  return {
    left,
    right,
    frame,
    tree,
    moved,
    guides: [guides[0].guide, guides[1].guide] as [
      WorkStyleGuide,
      WorkStyleGuide,
    ],
    snapshot: chapterMoveSnapshot(intent, frame, tree, moved),
  };
}

async function readGuide(workId: string) {
  const path = join(dirname(getWorkFilePath(workId)), "style-guide.json");
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), path, {
    allowMissingTarget: true,
  });
  if ((await pathState(path)) === "missing")
    return { guide: await readWorkStyleGuide(workId), version: null };
  const evidence = await inspectRetainedFile(path);
  const guide = WorkStyleGuideSchema.parse(await readBoundedJsonFile(path));
  if (guide.workId !== workId)
    throw new Error("Work context identity differs from its storage location.");
  return { guide, version: evidence.sha256 };
}
