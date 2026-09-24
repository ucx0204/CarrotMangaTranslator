import type {
  WorkStyleGuide,
  ChapterStoryMemory,
} from "../../shared/workContextTypes";
import {
  MCP_CONTEXT_GRAPH_CHAPTERS,
  MCP_CONTEXT_GRAPH_PAGES,
  MCP_CONTEXT_GRAPH_BLOCKS,
  MCP_CONTEXT_GRAPH_REFERENCES,
  type McpContextReferenceSnapshot,
} from "../../shared/mcpContextReferences";
import { openChapter } from "../libraryStore/libraryAccess";
import { readWorkFile } from "../libraryStore/libraryFiles";
import {
  readChapterStoryMemory,
  resolveWorkContextForChapter,
} from "../libraryStore/workContextFiles";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import {
  stageStoryMemoryFile,
  stageStyleGuideFile,
} from "../libraryStore/libraryTransactionFiles";
import {
  assertLibraryActivityAccess,
  withLibraryMutation,
  withLibraryRead,
} from "./lock";

/** Unlike the display projection, editing retains unrelated/orphaned memory rows. */
/** Native transaction callers must already hold the library read/write boundary. */
export async function readWorkContextEditSnapshotUnlocked(chapterId: string) {
  const context = await resolveWorkContextForChapter(chapterId);
  return {
    ...context,
    storyMemory: await readChapterStoryMemory(chapterId),
    chapter: await openChapter(chapterId),
  };
}

export function readWorkContextForEdit(chapterId: string) {
  return withLibraryRead(() => readWorkContextEditSnapshotUnlocked(chapterId));
}

/** Work-wide inspection must not silently skip a missing chapter or orphaned memory. */
export function readWorkContextReferences(
  chapterId: string,
  guard: () => void,
): Promise<McpContextReferenceSnapshot> {
  return withLibraryRead(() =>
    readWorkContextReferencesUnlocked(chapterId, guard),
  );
}

/** Native transaction callers must already hold the library boundary. */
export async function readWorkContextReferencesUnlocked(
  chapterId: string,
  guard: () => void,
): Promise<McpContextReferenceSnapshot> {
  guard();
  const anchor = await readWorkContextEditSnapshotUnlocked(chapterId);
  const work = await readWorkFile(anchor.workId);
  if (!work || !work.chapterOrder.includes(chapterId))
    throw new Error("The requested chapter no longer belongs to this work.");
  if (
    work.chapterOrder.length > MCP_CONTEXT_GRAPH_CHAPTERS ||
    new Set(work.chapterOrder).size !== work.chapterOrder.length
  )
    throw new Error(
      "Work chapter inventory is duplicated or exceeds the reference inspection budget.",
    );
  const chapters: McpContextReferenceSnapshot["chapters"] = [];
  let pages = 0;
  let blocks = 0;
  let memories = 0;
  for (const id of work.chapterOrder) {
    guard();
    const chapter = id === chapterId ? anchor.chapter : await openChapter(id);
    const storyMemory =
      id === chapterId ? anchor.storyMemory : await readChapterStoryMemory(id);
    if (
      chapter.workId !== work.id ||
      storyMemory.workId !== work.id ||
      storyMemory.chapterId !== id
    )
      throw new Error(
        "A chapter or memory does not belong to the complete work inventory.",
      );
    pages += chapter.pages.length;
    blocks += chapter.pages.reduce((sum, page) => sum + page.blocks.length, 0);
    memories += storyMemory.pages.length;
    assertReferenceBudget(pages, blocks, memories);
    chapters.push({ chapter, storyMemory });
  }
  guard();
  return {
    workId: work.id,
    workTitle: work.title,
    styleGuide: anchor.styleGuide,
    chapters,
  };
}

function assertReferenceBudget(
  pages: number,
  blocks: number,
  memories: number,
) {
  if (
    pages > MCP_CONTEXT_GRAPH_PAGES ||
    blocks > MCP_CONTEXT_GRAPH_BLOCKS ||
    memories > MCP_CONTEXT_GRAPH_REFERENCES
  )
    throw new Error(
      "Work context reference snapshot exceeds its bounded inspection budget.",
    );
}

/** The caller's policy runs INSIDE the normal library write queue. Both context
 * files share the existing publication/rollback protocol, including auth recheck. */
export function commitWorkContextEdit<T>(
  chapterId: string,
  transform: (
    current: Awaited<ReturnType<typeof readWorkContextEditSnapshotUnlocked>>,
  ) => {
    styleGuide?: WorkStyleGuide;
    storyMemory?: ChapterStoryMemory;
    result: T;
  },
  assertAuthorized: () => void,
): Promise<T> {
  return withLibraryMutation(async () => {
    assertAuthorized();
    const current = await readWorkContextEditSnapshotUnlocked(chapterId);
    assertLibraryActivityAccess([
      { kind: "work-context", scope: current.workId, access: "write" },
    ]);
    assertAuthorized();
    const changed = transform(current);
    if (
      (changed.styleGuide && changed.styleGuide.workId !== current.workId) ||
      (changed.storyMemory &&
        (changed.storyMemory.workId !== current.workId ||
          changed.storyMemory.chapterId !== chapterId))
    )
      throw new Error("Context edit cannot change work or chapter identity.");
    if (changed.styleGuide || changed.storyMemory) {
      await runLibraryTransaction("edit-work-context", async (transaction) => {
        if (changed.styleGuide)
          await stageStyleGuideFile(transaction, changed.styleGuide);
        if (changed.storyMemory)
          await stageStoryMemoryFile(transaction, changed.storyMemory);
        transaction.beforePublish(async () => {
          assertAuthorized();
        });
      });
    }
    return changed.result;
  });
}
