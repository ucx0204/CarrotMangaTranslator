import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { JobState } from "../../../shared/jobTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../../../shared/libraryTypes";
import type { BBox } from "../../../shared/textTypes";
import type { WorkContextAnalysisScope } from "../../../shared/workContextAnalysisTypes";
import type { ChapterRunSelection } from "../lib/translationSelection";
import type { RunAnalysisOutcome } from "./translationFlowHelpers";

export type RunAnalysisMode = "pending" | "all" | "single-page" | "page-set";

export type TranslationFlowOptions = {
  selection: ChapterRunSelection[];
  twoPass: boolean;
  analysisScope: WorkContextAnalysisScope;
  blockMode: AnalysisBlockMode;
};

export type UseTranslationActionsOptions = {
  clearStatusLines: () => void;
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  jobActive: boolean;
  library: LibraryIndex;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  beforeTranslateRegion?: () => Promise<void>;
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  saveNow: () => Promise<void>;
  selectedPage: MangaPage | null;
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
  ) => Promise<RunAnalysisOutcome>;
  runTranslationFlow: (options: TranslationFlowOptions) => Promise<void>;
  translateSelectedRegion: (bbox: BBox) => Promise<void>;
};
