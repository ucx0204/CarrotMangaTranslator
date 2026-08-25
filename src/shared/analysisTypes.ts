import type { BBox } from "./textTypes";
import type { ChapterSnapshot } from "./libraryTypes";
import type { TranslationCompletionWorkflow } from "./libraryTypes";
import type { JobFailureGuidance } from "./jobTypes";

export type AnalysisBlockMode = "auto" | "keep";

type TranslationRunOptions = {
  collectPageContext?: boolean;
  /** Insert natural hard line breaks into translated text for the detected block size. */
  naturalTextLayout?: boolean;
  /** Choose locale-compatible fonts for newly detected translation blocks. */
  autoFontMatching?: boolean;
  /** Match newly created text size to the source glyph face when reliable. */
  fontSizeAutoFit?: boolean;
  /** Required downstream stage for a combined translation workflow. */
  completionWorkflow?: TranslationCompletionWorkflow;
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
  failureGuidance?: JobFailureGuidance;
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
