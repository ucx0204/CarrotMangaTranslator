import type { ChapterSnapshot, ImportSourceKind } from "./libraryTypes";

export type ImportPageDraft = {
  name: string;
  sourcePath: string;
  sourceKind: "file" | "zip-entry";
  zipEntryName?: string;
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
