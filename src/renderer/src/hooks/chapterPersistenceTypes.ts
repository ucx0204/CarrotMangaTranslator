import type React from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";

export type SaveReason = "autosave" | "manual";

export type UseChapterPersistenceOptions = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  onSaveError?: (message: string) => void;
  setCurrentChapter: React.Dispatch<
    React.SetStateAction<ChapterSnapshot | null>
  >;
};

export type ServerPageVersion = {
  updatedAt: string;
  blocksHash: string;
};

export type ChapterPersistenceResult = {
  clearDirtyTracking: () => void;
  resetSaveBaseline: (chapter?: ChapterSnapshot | null) => void;
  dirty: boolean;
  dirtyPageIdsRef: React.MutableRefObject<Set<string>>;
  markDirty: (pageId?: string) => void;
  replaceDirtyPageIds: (pageIds: string[]) => void;
  saveNow: () => Promise<void>;
  syncSavedPageVersion: (chapter: ChapterSnapshot, pageId: string) => void;
};

export type ChapterPersistenceRefs = {
  blockedAutoSaveVersionRef: React.MutableRefObject<number | null>;
  dirtyPageIdsRef: React.MutableRefObject<Set<string>>;
  dirtyVersionRef: React.MutableRefObject<number>;
  lastSaveErrorRef: React.MutableRefObject<{
    message: string;
    shownAt: number;
  } | null>;
  saveAgainRequestedRef: React.MutableRefObject<boolean>;
  saveAgainReasonRef: React.MutableRefObject<SaveReason | null>;
  saveInFlightRef: React.MutableRefObject<boolean>;
  saveQueuePromiseRef: React.MutableRefObject<Promise<void> | null>;
  saveTimerRef: React.MutableRefObject<number | null>;
  serverVersionByPageIdRef: React.MutableRefObject<
    Map<string, ServerPageVersion>
  >;
  serverVersionChapterIdRef: React.MutableRefObject<string | null>;
};

export type ServerVersionSyncActions = {
  syncSavedPageVersion: (chapter: ChapterSnapshot, pageId: string) => void;
  syncServerPageVersions: (
    chapter: ChapterSnapshot | null,
    options?: { preserveDirtyPages?: boolean },
  ) => void;
};

export type PersistChapter = (
  chapter: ChapterSnapshot,
  options?: {
    dirtyVersion?: number;
    saveReason?: SaveReason;
    syncState?: boolean;
  },
) => Promise<ChapterSnapshot>;

export type QueuedSaveRunner = (reason: SaveReason) => Promise<void>;

export type DirtyTrackingActions = Pick<
  ChapterPersistenceResult,
  | "clearDirtyTracking"
  | "markDirty"
  | "replaceDirtyPageIds"
  | "resetSaveBaseline"
  | "saveNow"
>;
