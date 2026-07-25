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
