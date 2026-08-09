import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";
import type { ChapterSaveStatus } from "../hooks/chapterPersistenceTypes";

export type ChapterTaskHubProps = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  flowActive: boolean;
  saveStatus: ChapterSaveStatus;
  onOpenExport: () => void;
  onOpenTranslateOptions: () => void;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
  onRunBubbleLayout: () => void;
  onRunCurrentPageInpainting: () => void;
  onRetrySave: () => void;
  hasSelectedPage: boolean;
  canRunBubbleLayout: boolean;
};
