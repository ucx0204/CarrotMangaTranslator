import type { BBox } from "./textTypes";
import type { ChapterSnapshot } from "./libraryTypes";

export type StartAnalysisRequest =
  | {
      chapterId: string;
      runMode: "pending";
    }
  | {
      chapterId: string;
      runMode: "all";
    }
  | {
      chapterId: string;
      runMode: "single-page";
      pageId: string;
    };

export type StartAnalysisResult = {
  status: "completed" | "cancelled" | "failed";
  chapter?: ChapterSnapshot;
  warnings?: string[];
  error?: string;
};

export type RegionAnalysisRequest = {
  chapterId: string;
  pageId: string;
  bbox: BBox;
};

export type RegionAnalysisResult = StartAnalysisResult & {
  pageId?: string;
  blockIds?: string[];
};
