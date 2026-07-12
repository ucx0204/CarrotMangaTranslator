import type {
  WorkShareImportEntry,
  WorkShareImportRequest,
  WorkSharePreviewChapter,
} from "../../../shared/shareTypes";

export type ShareImportModalSubmit = {
  target: WorkShareImportRequest["target"];
  entries: WorkShareImportEntry[];
  remainingPackageChapters: WorkSharePreviewChapter[];
  deletedExistingChapters: Array<{ id: string; title: string }>;
};
