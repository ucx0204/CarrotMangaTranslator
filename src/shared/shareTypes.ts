import type { ChapterSnapshot } from "./libraryTypes";
import type { TranslationBlock } from "./textTypes";

export type SavePageBlocksRequest = {
  chapterId: string;
  pageId: string;
  baseUpdatedAt?: string;
  blocks: TranslationBlock[];
};

export type WorkShareExportRequest = {
  workId: string;
  chapterIds: string[];
};

export type WorkShareExportResult = {
  filePath: string;
  workTitle: string;
  chapterCount: number;
  pageCount: number;
};

export type WorkSharePreviewChapter = {
  packageChapterId: string;
  title: string;
  pageCount: number;
};

export type WorkShareImportPreviewView = {
  workTitle: string;
  chapters: WorkSharePreviewChapter[];
};

export type WorkShareImportPreview = WorkShareImportPreviewView & {
  previewId: string;
};

export type WorkShareImportEntry =
  | {
      source: "existing";
      chapterId: string;
      title: string;
    }
  | {
      source: "package";
      packageChapterId: string;
      title: string;
    };

export type WorkShareImportRequest = {
  previewId: string;
  target:
    | {
        mode: "new";
        title: string;
      }
    | {
        mode: "existing";
        workId: string;
      };
  entries: WorkShareImportEntry[];
};

export type WorkShareImportFromPackageRequest = {
  packagePath: string;
  target:
    | {
        mode: "new";
        title: string;
      }
    | {
        mode: "existing";
        workId: string;
      };
  entries: WorkShareImportEntry[];
};

export type WorkShareImportResult = {
  workId: string;
  chapterIds: string[];
  openedChapter?: ChapterSnapshot;
};
