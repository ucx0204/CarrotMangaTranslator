import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";

export type ChapterTaskHubProps = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  flowActive: boolean;
  onOpenExport: () => void;
  onOpenTranslateOptions: () => void;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
  onRunBubbleLayout: () => void;
  onRunCurrentPageInpainting: () => void;
  hasSelectedPage: boolean;
  canRunBubbleLayout: boolean;
};
