import type { TranslationBlock } from "./textTypes";
import type { PageProcessingTiming } from "./pageProcessingTiming";
import type {
  FontContinuityMetadata,
  TranslationCheckpointMetadata,
} from "./translationCheckpoint";

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

export type ImportSourceKind =
  | "images"
  | "folder"
  | "zip"
  | "rar"
  | "pdf"
  | "zip-folder";

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
  /** Original file name retained for linked-workspace mirroring. */
  sourceFileName?: string;
  /** POSIX-style path relative to the linked source root. */
  sourceRelativePath?: string;
  /** Internal full-page inpainting mask artifact. */
  inpaintMaskPath?: string;
  maskProvenance?: "actual-mask" | "retouch-updated" | "derived-diff";
  dataUrl: string;
  width: number;
  height: number;
  blocks: TranslationBlock[];
  /** Explicit reading order. Missing or stale ids are repaired at read time. */
  blockOrder?: string[];
  analysisStatus: PageAnalysisStatus;
  /**
   * Present when translation was started as a combined workflow. A translated
   * page is not considered complete until the requested erase/postprocess
   * stage has persisted its result and flips this receipt to completed.
   */
  translationCompletion?: TranslationCompletionReceipt;
  /** Internal resumable model-stage artifact. Excluded from shared exports. */
  translationCheckpoint?: TranslationCheckpointMetadata;
  /** Verified font observations used only to restore chapter continuity. */
  fontContinuity?: FontContinuityMetadata;
  /** Last measured full-page processing stages, stored as integer milliseconds. */
  processingTiming?: PageProcessingTiming;
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
  /** Overrides source-language inference for block reading order. */
  readingDirection?: "auto" | "rtl" | "ltr";
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
