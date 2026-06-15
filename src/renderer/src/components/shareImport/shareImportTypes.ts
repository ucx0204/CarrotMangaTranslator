import type {
  WorkShareImportEntry,
  WorkShareImportRequest,
  WorkSharePreviewChapter,
} from "../../../../shared/types";

export type LeftItem =
  | {
      key: string;
      source: "existing";
      chapterId: string;
      title: string;
      pageCount: number;
    }
  | {
      key: string;
      source: "package";
      packageChapterId: string;
      title: string;
      pageCount: number;
    };

export type ShareImportModalSubmit = {
  target: WorkShareImportRequest["target"];
  entries: WorkShareImportEntry[];
  remainingPackageChapters: WorkSharePreviewChapter[];
  deletedExistingChapters: Array<{ id: string; title: string }>;
};

export type ActiveDrag =
  | {
      type: "left";
      item: LeftItem;
    }
  | {
      type: "candidate";
      chapter: WorkSharePreviewChapter;
    };

export const LEFT_DROPZONE_ID = "share-left-dropzone";
export const CANDIDATE_PREFIX = "candidate:";
