import type { JobState } from "../../../shared/jobTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";
import type { ProgressSnapshot } from "../lib/jobProgress";

export type ChapterTaskHubProps = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  flowActive: boolean;
  showProgressBar: boolean;
  progressSnapshot: ProgressSnapshot | null;
  jobState: JobState;
  onOpenExport: () => void;
  onOpenTranslateOptions: () => void;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
  onRunBubbleLayout: () => void;
  onRunCurrentPageInpainting: () => void;
  onCancelJob: () => void;
  hasSelectedPage: boolean;
  canRunBubbleLayout: boolean;
};
