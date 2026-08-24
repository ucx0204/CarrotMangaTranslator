export type PageImageExportChapterSelection =
  | {
      chapterId: string;
      mode: "all";
    }
  | {
      chapterId: string;
      mode: "page-set";
      pageIds: string[];
    };

export type PageImageExportRequest = {
  workId: string;
  selections: PageImageExportChapterSelection[];
  expectedTargets?: PageJobTargetSnapshot[];
  /** Export only the cleaned inpainted image and omit translated text blocks. */
  omitText?: boolean;
  outputFormat?: PageImageExportFormat;
  jpegQuality?: number;
  webpQuality?: number;
  preserveSourceNames?: boolean;
  destinationMode?: "timestamped" | "fixed";
  collisionPolicy?: "replace" | "skip" | "cancel";
};

export type PageImageExportFormat = "source" | "png" | "jpeg" | "webp";

export type PagePsdExportRequest = Omit<
  PageImageExportRequest,
  | "outputFormat"
  | "jpegQuality"
  | "webpQuality"
  | "preserveSourceNames"
  | "destinationMode"
> & {
  collisionPolicy?: "replace" | "skip" | "cancel";
};

export type PageExportSelectionRequest =
  | PageImageExportRequest
  | (PagePsdExportRequest & { outputFormat: "psd" });

export const PAGE_IMAGE_EXPORT_PREFLIGHT_ISSUE_CODES = [
  "job-running",
  "translation-failed",
  "translation-pending",
  "postprocess-pending",
  "inpainted-image-missing",
  "empty-translation",
] as const;

type PageImageExportPreflightIssueCode =
  (typeof PAGE_IMAGE_EXPORT_PREFLIGHT_ISSUE_CODES)[number];

export type PageImageExportPreflightIssue = {
  code: PageImageExportPreflightIssueCode;
  severity: "warning" | "info";
  chapterId: string;
  chapterTitle: string;
  pageId: string;
  pageName: string;
};

export type PageImageExportPreflightResult = {
  workTitle: string;
  chapterCount: number;
  pageCount: number;
  sampleRelativePath: string;
  outputPolicy: "new-timestamped-folder" | "fixed-folder";
  issues: PageImageExportPreflightIssue[];
  targets: PageJobTargetSnapshot[];
};

export type PageImageExportCompletedResult = {
  status: "completed";
  outputDir: string;
  pageCount: number;
  openError?: string;
};

export type PageImageExportCancelledResult = {
  status: "cancelled";
};

export type PageImageExportResult =
  | PageImageExportCompletedResult
  | PageImageExportCancelledResult;
import type { PageJobTargetSnapshot } from "./pageRevision";
