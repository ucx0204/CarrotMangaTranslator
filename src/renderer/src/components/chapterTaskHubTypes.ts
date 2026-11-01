import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";
import type { LinkedWorkspaceStatus } from "../../../shared/linkedWorkspaceTypes";

export type ChapterTaskHubProps = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  flowActive: boolean;
  linkedWorkspaceStatus: LinkedWorkspaceStatus | null;
  linkedWorkspaceViewBusy: boolean;
  /** This chapter's result folder is being reorganized by a local request. */
  linkedWorkspaceOrganizing: boolean;
  /** Display names owned by the shared output commands. */
  exportLabel: string;
  psdExportLabel: string;
  viewResultsLabel: string;
  /** Display names owned by the translate/chat commands (palette parity). */
  translateLabel?: string;
  chatTranslateLabel?: string;
  onOpenExport: () => void;
  onOpenPsdExport: () => void;
  onViewLinkedResults: () => void;
  onRetryLinkedResults: () => void;
  onOpenPreviousLinkedResults: () => void;
  onOpenTranslateOptions: () => void;
  onOpenChat?: () => void;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
  onRunBubbleLayout: () => void;
  hasSelectedPage: boolean;
  canRunBubbleLayout: boolean;
};
