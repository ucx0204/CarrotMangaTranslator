export type WorkContextUsageLastSeen = {
  chapterId: string;
  chapterTitle: string;
  chapterIndex: number;
  pageId: string;
  pageName: string;
  pageIndex: number;
};

export type WorkContextUsageMetric = {
  id: string;
  pageCount: number;
  mentionCount: number;
  lastSeen?: WorkContextUsageLastSeen;
};

export type WorkContextUsage = {
  workId: string;
  glossary: WorkContextUsageMetric[];
  characters: WorkContextUsageMetric[];
};
