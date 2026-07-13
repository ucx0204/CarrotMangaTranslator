import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { RenameTarget } from "../lib/libraryRenameTypes";
import type { ChapterSnapshot, LibraryIndex } from "./hookLibraryTypes";

export type { ChapterSnapshot, LibraryIndex } from "./hookLibraryTypes";

type AskConfirm = (
  title: string,
  message: string,
  detail?: string,
) => Promise<boolean>;

export type UseLibraryActionsOptions = {
  askConfirm: AskConfirm;
  clearDirtyTracking: () => void;
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  dirty: boolean;
  hasPendingInpaintingMask?: boolean;
  library: LibraryIndex;
  onChapterOpened?: () => void;
  pushStatus: (line: string) => void;
  resetSaveBaseline: (chapter?: ChapterSnapshot | null) => void;
  saveNow: () => Promise<void>;
  clearPendingInpaintingMasks?: () => void;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setLibrary: Dispatch<SetStateAction<LibraryIndex>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
};

export type ApplyChapterAction = (
  chapter: ChapterSnapshot | undefined,
  fallbackStatus?: string,
) => void;

export type LibraryChapterSelectionActions = {
  applyChapter: ApplyChapterAction;
  clearCurrentChapter: () => void;
  openChapter: (chapterId: string) => Promise<void>;
  refreshLibrary: () => Promise<void>;
};

export type LibraryRenameActions = {
  deleteRenameTarget: () => Promise<void>;
  renameBusy: boolean;
  renameChapter: (chapterId: string) => void;
  renameTarget: RenameTarget | null;
  renameWork: (workId: string) => void;
  setRenameTarget: Dispatch<SetStateAction<RenameTarget | null>>;
  submitRename: (title: string) => Promise<void>;
};

export type LibraryReorderActions = {
  reorderChapterInLibrary: (
    workId: string,
    sourceChapterId: string,
    targetChapterId: string,
  ) => void;
  reorderPageInChapter: (sourcePageId: string, targetPageId: string) => void;
};

export type UseLibraryActionsResult = LibraryChapterSelectionActions &
  LibraryRenameActions &
  LibraryReorderActions & {
    removePage: (pageId: string) => Promise<void>;
  };
