import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { JobState } from "../../../shared/jobTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../../../shared/libraryTypes";
import type { BBox } from "../../../shared/textTypes";
import type { TranslationWorkflowMode } from "../../../shared/settingsTypes";
import type { WorkContextAnalysisScope } from "../../../shared/workContextAnalysisTypes";
import type { LiveChapterMergeOptions } from "../lib/chapterSync";
import type { ChapterRunSelection } from "../lib/translationSelection";
import type { RunAnalysisOutcome } from "./translationFlowHelpers";

export type RunAnalysisMode = "pending" | "all" | "single-page" | "page-set";

export type TranslationFlowOptions = {
  selection: ChapterRunSelection[];
  workflowMode: TranslationWorkflowMode;
  analysisScope: WorkContextAnalysisScope;
  blockMode: AnalysisBlockMode;
};

export type UseTranslationActionsOptions = {
  clearStatusLines: () => void;
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  jobActive: boolean;
  library: LibraryIndex;
  mergeLiveChapter: (
    chapter: ChapterSnapshot,
    options?: LiveChapterMergeOptions,
  ) => void;
  beforeTranslate?: () => Promise<void>;
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  saveNow: () => Promise<void>;
  syncSavedPageVersion: (chapter: ChapterSnapshot, pageId: string) => void;
  selectedPage: MangaPage | null;
  translationWorkflowDefault?: TranslationWorkflowMode;
  analysisScopeDefault?: WorkContextAnalysisScope;
  blockModeDefault?: AnalysisBlockMode;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setFlowActive: (active: boolean) => void;
  setJobState: Dispatch<SetStateAction<JobState>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
};

export type TranslationActions = {
  runAnalysis: (
    runMode: RunAnalysisMode,
    pageId?: string,
    chapterId?: string,
    blockMode?: AnalysisBlockMode,
    collectPageContext?: boolean,
  ) => Promise<RunAnalysisOutcome>;
  runTranslationFlow: (
    options: TranslationFlowOptions,
  ) => Promise<RunAnalysisOutcome>;
  translateSelectedRegion: (bbox: BBox) => Promise<void>;
  ocrSelectedBlock: (blockId: string) => Promise<void>;
  translateSelectedBlock: (blockId: string) => Promise<void>;
};
