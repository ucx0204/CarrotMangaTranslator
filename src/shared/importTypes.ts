import type { ChapterSnapshot, ImportSourceKind } from "./libraryTypes";

export type ImportPageDraft = {
  name: string;
  sourcePath: string;
  sourceKind: "file" | "zip-entry";
  zipEntryName?: string;
  /** Optional web-import-only numeric stem for the actual stored file name. */
  storageStem?: string;
};

export type ImportChapterDraft = {
  draftId: string;
  title: string;
  sourceKind: ImportSourceKind;
  pages: ImportPageDraft[];
};

export type ImportPreviewResult = {
  mode: "single" | "batch";
  sourceKind: ImportSourceKind;
  suggestedWorkTitle: string;
  chapters: ImportChapterDraft[];
};

export type ImportPreviewSession = ImportPreviewResult & {
  previewId: string;
};

export const MAX_DROPPED_IMPORT_PATHS = 2000;

type DroppedImportRejectionReason =
  | "busy"
  | "empty"
  | "too-many-items"
  | "folder-must-be-alone"
  | "archive-must-be-alone"
  | "unsupported-files"
  | "folder-no-images"
  | "archive-no-images";

export type DroppedImportPreviewResponse =
  | {
      status: "ready";
      preview: ImportPreviewSession;
    }
  | {
      status: "rejected";
      reason: DroppedImportRejectionReason;
      names?: string[];
      count?: number;
    };

export type ImportTarget =
  | {
      mode: "new";
      title: string;
    }
  | {
      mode: "existing";
      workId: string;
    };

export type ImportCreateSelection = {
  draftId: string;
  title: string;
  enabled: boolean;
};

export type CreateImportRequest = {
  previewId: string;
  target: ImportTarget;
  selections: ImportCreateSelection[];
};

export type CreateImportFromPreviewRequest = {
  preview: ImportPreviewResult;
  target: ImportTarget;
  selections: ImportCreateSelection[];
};

export type CreateImportResult = {
  workId: string;
  chapterIds: string[];
  openedChapter?: ChapterSnapshot;
};
