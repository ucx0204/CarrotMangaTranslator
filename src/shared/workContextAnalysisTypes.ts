import type { ChapterStoryMemory, WorkStyleGuide } from "./workContextTypes";

export const WORK_CONTEXT_ANALYSIS_CANCELLED_ERROR =
  "WORK_CONTEXT_ANALYSIS_CANCELLED";

export type WorkContextAnalysisScope = "chapter" | "work" | "missing";

export type AnalyzeWorkContextRequest = {
  chapterId: string;
  scope?: WorkContextAnalysisScope;
  maxInputChars?: number;
};

export type WorkContextAnalysisCoverage = {
  scope: WorkContextAnalysisScope;
  workId: string;
  requestedChapterId: string;
  totalChapters: number;
  includedChapters: number;
  totalPages: number;
  includedPages: number;
  selectedChars: number;
  maxInputChars: number;
  truncated: boolean;
};

export type WorkContextAnalysisCounts = {
  glossaryAdded: number;
  glossaryUpdated: number;
  charactersAdded: number;
  charactersUpdated: number;
  rulesUpdated: number;
  pageSummariesUpserted: number;
};

export type AnalyzeWorkContextResult = {
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
  coverage: WorkContextAnalysisCoverage;
  counts: WorkContextAnalysisCounts;
  warnings: string[];
};
