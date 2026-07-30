import type { BBox } from "./textTypes";
import type { ChapterSnapshot } from "./libraryTypes";

export type AnalysisBlockMode = "auto" | "keep";

type TranslationRunOptions = {
  collectPageContext?: boolean;
  /** Insert natural hard line breaks into translated text for the detected block size. */
  naturalTextLayout?: boolean;
  /** Choose locale-compatible fonts for newly detected translation blocks. */
  autoFontMatching?: boolean;
};

export type StartAnalysisRequest = TranslationRunOptions &
  (
    | {
        chapterId: string;
        runMode: "pending";
        blockMode?: AnalysisBlockMode;
      }
    | {
        chapterId: string;
        runMode: "all";
        blockMode?: AnalysisBlockMode;
      }
    | {
        chapterId: string;
        runMode: "single-page";
        pageId: string;
        blockMode?: AnalysisBlockMode;
      }
    | {
        chapterId: string;
        runMode: "page-set";
        pageIds: string[];
        blockMode?: AnalysisBlockMode;
      }
  );

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
