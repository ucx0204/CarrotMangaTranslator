import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { WorkspaceHistoryController } from "./useWorkspaceHistory";
import {
  captureWorkspaceChapterEditSnapshot,
  type WorkspaceSelectionSnapshot,
} from "../lib/workspaceHistory";

type UpdateCurrentChapterOptions = {
  /** Coalescing key passed through to the undo history. */
  mergeKey?: string;
  /** Human-readable operation name shown by the shared Undo/Redo controls. */
  label?: string;
  /** Selection produced by operations which create/delete/select a block. */
  selectionAfter?: WorkspaceSelectionSnapshot;
  /** Multi-page edits can mark every affected page dirty in one history step. */
  dirtyPageIds?: string[];
  /** Background/live updates set this so they are not recorded as undo steps. */
  skipHistory?: boolean;
};

type UseCurrentChapterUpdaterOptions = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  markDirty: (pageId?: string) => void;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  selection: WorkspaceSelectionSnapshot;
  workspaceHistory: Pick<WorkspaceHistoryController, "recordChapterEdit">;
};

export type UpdateCurrentChapter = (
  pageId: string,
  updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
  options?: UpdateCurrentChapterOptions,
) => void;

export function useCurrentChapterUpdater({
  currentChapterRef,
  markDirty,
  setCurrentChapter,
  selection,
  workspaceHistory,
}: UseCurrentChapterUpdaterOptions): UpdateCurrentChapter {
  return useCallback(
    (pageId, updater, options = {}) => {
      const current = currentChapterRef.current;
      if (!current) {
        return;
      }

      const next = updater(current);
      if (next === current) {
        return;
      }
      markEditedPagesDirty(pageId, options, markDirty);
      currentChapterRef.current = next;
      setCurrentChapter(next);
      recordCompletedEdit({
        current,
        next,
        options,
        selection,
        workspaceHistory,
      });
    },
    [
      currentChapterRef,
      markDirty,
      selection,
      setCurrentChapter,
      workspaceHistory,
    ],
  );
}

function markEditedPagesDirty(
  pageId: string,
  options: UpdateCurrentChapterOptions,
  markDirty: (pageId?: string) => void,
): void {
  for (const dirtyPageId of options.dirtyPageIds ?? [pageId]) {
    markDirty(dirtyPageId);
  }
}

function recordCompletedEdit({
  current,
  next,
  options,
  selection,
  workspaceHistory,
}: {
  current: ChapterSnapshot;
  next: ChapterSnapshot;
  options: UpdateCurrentChapterOptions;
  selection: WorkspaceSelectionSnapshot;
  workspaceHistory: Pick<WorkspaceHistoryController, "recordChapterEdit">;
}): void {
  if (options.skipHistory) return;
  workspaceHistory.recordChapterEdit({
    label: options.label ?? "텍스트 블록 편집",
    mergeKey: options.mergeKey,
    before: captureWorkspaceChapterEditSnapshot(current, selection),
    after: captureWorkspaceChapterEditSnapshot(
      next,
      options.selectionAfter ?? selection,
    ),
  });
}
