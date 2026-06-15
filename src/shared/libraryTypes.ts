import type { TranslationBlock } from "./textTypes";

export type PageAnalysisStatus = "idle" | "running" | "completed" | "failed";

export type ChapterStatus =
  | "idle"
  | "running"
  | "completed"
  | "partial"
  | "failed";

export type RunMode = "pending" | "all" | "single-page";

export type ImportSourceKind = "images" | "folder" | "zip" | "zip-folder";

export type CustomFont = {
  id: string;
  label: string;
  family: string;
  fileName: string;
};

export type MangaPage = {
  id: string;
  name: string;
  imagePath: string;
  inpaintedImagePath?: string;
  dataUrl: string;
  width: number;
  height: number;
  blocks: TranslationBlock[];
  analysisStatus: PageAnalysisStatus;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type LibraryPageRecord = Omit<MangaPage, "dataUrl">;

export type LibraryChapter = {
  id: string;
  workId: string;
  title: string;
  sourceKind: ImportSourceKind;
  status: ChapterStatus;
  pageOrder: string[];
  pages: LibraryPageRecord[];
  createdAt: string;
  updatedAt: string;
};

export type ChapterSnapshot = Omit<LibraryChapter, "pages"> & {
  pages: MangaPage[];
};

export type LibraryChapterSummary = Pick<
  LibraryChapter,
  "id" | "workId" | "title" | "status" | "createdAt" | "updatedAt"
> & {
  pageCount: number;
};

export type LibraryWork = {
  id: string;
  title: string;
  chapterOrder: string[];
  createdAt: string;
  updatedAt: string;
};

export type LibraryWorkSummary = LibraryWork & {
  chapters: LibraryChapterSummary[];
};

export type LibraryIndex = {
  workOrder: string[];
  works: LibraryWorkSummary[];
};
