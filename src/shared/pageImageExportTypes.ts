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

export type PageImageExportResult = {
  outputDir: string;
  pageCount: number;
  openError?: string;
};
