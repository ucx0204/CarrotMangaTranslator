import type { ChapterSnapshot } from "./libraryTypes";

export type AutoInpaintingChapterSelection =
  | {
      chapterId: string;
      mode: "all";
    }
  | {
      chapterId: string;
      mode: "page-set";
      pageIds: string[];
    };

export type BubbleLayoutPolicy = "safe" | "balanced" | "maximize";

export type InpaintingPostprocessOptions = {
  bubbleLayout?: {
    enabled: boolean;
    policy: BubbleLayoutPolicy;
    /**
     * Recompute automatic hard line breaks after the final balloon geometry
     * is known. This avoids preserving wrapping measured against the OCR bbox.
     */
    naturalTextLayout?: boolean;
  };
};

type StartInpaintingTargetRequest =
  | {
      chapterId: string;
      mode: "chapter-pattern-pending";
    }
  | {
      chapterId: string;
      mode: "page-pattern";
      pageId: string;
      blockId?: string;
    }
  | {
      chapterId: string;
      mode: "page-pattern-drawn";
      pageId: string;
      strokes: InpaintingMaskStroke[];
      featherPx?: number;
    }
  | {
      chapterId: string;
      mode: "page-bubble-layout";
      pageId: string;
      blockId?: string;
      policy: BubbleLayoutPolicy;
    }
  | {
      mode: "selection-pattern";
      workId: string;
      selections: AutoInpaintingChapterSelection[];
    };

export type StartInpaintingRequest = StartInpaintingTargetRequest & {
  postprocess?: InpaintingPostprocessOptions;
};

export type StartInpaintingResult = {
  status: "completed" | "partial" | "cancelled" | "failed";
  chapter?: ChapterSnapshot;
  chapters?: ChapterSnapshot[];
  pagesChanged?: number;
  blocksErased?: number;
  pagesIncomplete?: number;
  blocksIncomplete?: number;
  historyTransaction?: InpaintingHistoryTransactionRef;
  error?: string;
};

export type InpaintingHistoryTransactionRef = {
  transactionId: string;
};

export type ApplyInpaintingHistoryTransactionRequest = {
  transactionId: string;
  direction: "undo" | "redo";
};

export type ApplyInpaintingHistoryTransactionResult = {
  transactionId: string;
  direction: "undo" | "redo";
  chapters: ChapterSnapshot[];
  pagesChanged: number;
  /**
   * True only when applying the revision and restoring its previous server
   * state both failed. The transaction is no longer replayable in this case;
   * `chapters` contains the best-effort reread of the authoritative state.
   */
  invalidated: boolean;
};

export type ReleaseInpaintingHistoryTransactionsRequest = {
  transactionIds: string[];
};

export type ReleaseInpaintingHistoryTransactionsResult = {
  released: number;
};

export type InpaintingPoint = {
  x: number;
  y: number;
};

export type InpaintingMaskStroke = {
  points: InpaintingPoint[];
  radiusPx: number;
};

type InpaintingRetouchStrokeGeometry = {
  kind: "stroke";
  points: InpaintingPoint[];
  radiusPx: number;
};

export type InpaintingRetouchShapeGeometry = {
  kind: "rectangle" | "ellipse";
  start: InpaintingPoint;
  end: InpaintingPoint;
};

export type InpaintingRetouchGeometry =
  | InpaintingRetouchStrokeGeometry
  | InpaintingRetouchShapeGeometry;

export type InpaintingRetouchRequest = {
  chapterId: string;
  pageId: string;
  mode: "paint" | "restore";
  geometry: InpaintingRetouchGeometry;
  color?: string;
  retainedInpaintedArtifactPaths?: string[];
};

export type InpaintingRetouchResult = {
  chapter: ChapterSnapshot;
  pageId: string;
  historyTransaction?: InpaintingHistoryTransactionRef;
};

export type InpaintingRevertRequest =
  | {
      chapterId: string;
      scope: "chapter";
    }
  | {
      chapterId: string;
      scope: "page";
      pageId: string;
    };

export type InpaintingRevertResult = {
  chapter: ChapterSnapshot;
  pagesChanged: number;
  historyTransaction?: InpaintingHistoryTransactionRef;
};

export type InpaintingColorSampleRequest = {
  imagePath: string;
  x: number;
  y: number;
};

export type InpaintingColorSampleResult = {
  color: string;
};

export type SetPageInpaintingResultRequest = {
  chapterId: string;
  pageId: string;
  inpaintedImagePath?: string | null;
  retainedInpaintedArtifactPaths?: string[];
};

export type SetPageInpaintingResultResult = {
  chapter: ChapterSnapshot;
  pageId: string;
};
