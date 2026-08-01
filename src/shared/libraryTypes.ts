import type { TranslationBlock } from "./textTypes";

export type PageAnalysisStatus = "idle" | "running" | "completed" | "failed";

export type TranslationCompletionWorkflow = "erase-original" | "bubble-layout";

export type TranslationCompletionReceipt = {
  workflow: TranslationCompletionWorkflow;
  status: "pending" | "completed" | "failed";
  /**
   * Blocks whose source text has already been erased by a partially completed
   * full-page workflow. A retry starts from the saved partial image and skips
   * these blocks so that successful work is not thrown away or reprocessed.
   */
  erasedBlockIds?: readonly string[];
};

type ChapterStatus = "idle" | "running" | "completed" | "partial" | "failed";

export type RunMode = "pending" | "all" | "single-page" | "page-set";

export type ImportSourceKind = "images" | "folder" | "zip" | "zip-folder";

export type CustomFont = {
  id: string;
  label: string;
  family: string;
  fileName: string;
};

export type FontPreferences = {
  favoriteIds: string[];
  orderedIds: string[];
  defaultFontId: string;
};

export type FontLibrarySnapshot = {
  customFonts: CustomFont[];
  preferences: FontPreferences;
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
  /**
   * Present when translation was started as a combined workflow. A translated
   * page is not considered complete until the requested erase/postprocess
   * stage has persisted its result and flips this receipt to completed.
   */
  translationCompletion?: TranslationCompletionReceipt;
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
