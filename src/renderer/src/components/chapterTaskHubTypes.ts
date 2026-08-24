import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";
import type { ChapterSaveStatus } from "../hooks/chapterPersistenceTypes";
import type { LinkedWorkspaceStatus } from "../../../shared/linkedWorkspaceTypes";

export type ChapterTaskHubProps = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  flowActive: boolean;
  saveStatus: ChapterSaveStatus;
  linkedWorkspaceStatus: LinkedWorkspaceStatus | null;
  linkedWorkspaceViewBusy: boolean;
  onOpenExport: () => void;
  onOpenPsdExport: () => void;
  onViewLinkedResults: () => void;
  onOpenTranslateOptions: () => void;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
  onRunBubbleLayout: () => void;
  onRetrySave: () => void;
  hasSelectedPage: boolean;
  canRunBubbleLayout: boolean;
};
