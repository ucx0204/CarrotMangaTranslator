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
};

export type PageImageExportFormat = "png" | "psd";

type PageImageExportPreflightIssueCode =
  | "job-running"
  | "translation-failed"
  | "translation-pending"
  | "postprocess-pending"
  | "inpainted-image-missing"
  | "empty-translation";

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
  outputPolicy: "new-timestamped-folder";
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
