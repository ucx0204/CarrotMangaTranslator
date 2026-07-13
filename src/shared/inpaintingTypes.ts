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

export type StartInpaintingRequest =
  | {
      chapterId: string;
      mode: "chapter-pattern-pending";
    }
  | {
      chapterId: string;
      mode: "page-pattern";
      pageId: string;
    }
  | {
      chapterId: string;
      mode: "page-pattern-drawn";
      pageId: string;
      strokes: InpaintingMaskStroke[];
      featherPx?: number;
    }
  | {
      mode: "selection-pattern";
      workId: string;
      selections: AutoInpaintingChapterSelection[];
    };

export type StartInpaintingResult = {
  status: "completed" | "cancelled" | "failed";
  chapter?: ChapterSnapshot;
  chapters?: ChapterSnapshot[];
  pagesChanged?: number;
  blocksErased?: number;
  error?: string;
};

export type InpaintingPoint = {
  x: number;
  y: number;
};

export type InpaintingMaskStroke = {
  points: InpaintingPoint[];
  radiusPx: number;
};

export type InpaintingRetouchRequest = {
  chapterId: string;
  pageId: string;
  mode: "paint" | "restore";
  points: InpaintingPoint[];
  radiusPx: number;
  color?: string;
  retainedInpaintedArtifactPaths?: string[];
};

export type InpaintingRetouchResult = {
  chapter: ChapterSnapshot;
  pageId: string;
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
