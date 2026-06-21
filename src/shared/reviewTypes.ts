import type { ChapterSnapshot } from "./libraryTypes";

export type ReviewExportFormat = "csv" | "tsv";

export type ExportReviewTextRequest = {
  chapterId: string;
  format: ReviewExportFormat;
  includeBom?: boolean;
};

export type ImportReviewTextRequest = {
  chapterId: string;
  content: string;
  format: ReviewExportFormat | "auto";
  updateSourceText?: boolean;
  requireSourceMatch?: boolean;
};

export type ImportReviewTextResult = {
  chapter: ChapterSnapshot;
  updatedBlockCount: number;
  skippedRowCount: number;
  warnings: string[];
};
