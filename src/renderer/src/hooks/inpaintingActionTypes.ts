import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  InpaintingMaskStroke,
  StartInpaintingResult,
} from "../../../shared/inpaintingTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import { formatErrorMessage } from "../lib/errorPresentation";
import type { WorkspaceHistoryController } from "./useWorkspaceHistory";

export type InpaintingPreviewStageInput = {
  result: StartInpaintingResult;
  afterChapter: ChapterSnapshot;
  pageId: string;
  label: string;
  maskBefore?: InpaintingMaskStroke[];
};

export type InpaintingScope = "page" | "chapter";

export type InpaintingActionTarget = {
  chapterId: string;
  page: MangaPage | null;
  pageId: string | null;
};

export type UseInpaintingActionsOptions = {
  askConfirm: (
    title: string,
    message: string,
    detail?: string,
  ) => Promise<boolean>;
  clearPageImageCache: () => void;
  clearRetouchHistory: () => void;
  currentChapter: ChapterSnapshot | null;
  dirty: boolean;
  flowCancellationRef?: MutableRefObject<boolean>;
  jobActive: boolean;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  patternMaskStrokes: InpaintingMaskStroke[];
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  saveNow: () => Promise<void>;
  selectedPage: MangaPage | null;
  setInpaintingTool: Dispatch<SetStateAction<InpaintingTool>>;
  setFlowActive: (active: boolean) => void;
  setJobState: Dispatch<SetStateAction<JobState>>;
  setPatternMaskStrokesByPage: Dispatch<
    SetStateAction<Record<string, InpaintingMaskStroke[]>>
  >;
  setPeekOriginal: Dispatch<SetStateAction<boolean>>;
  setShowBlockChrome: (visible: boolean) => void;
  workspaceHistory: Pick<WorkspaceHistoryController, "recordImageEdit">;
  stageInpaintingPreview?: (
    input: InpaintingPreviewStageInput,
  ) => Promise<boolean>;
};

export function failInpaintingJob(
  setJobState: Dispatch<SetStateAction<JobState>>,
  pushStatus: (line: string) => void,
  progressText: string,
  message: string,
): void {
  setJobState({
    id: "failed-inpainting",
    kind: "inpainting",
    status: "failed",
    progressText,
    detail: message,
  });
  pushStatus(message);
}

export function failExportJob(
  setJobState: Dispatch<SetStateAction<JobState>>,
  pushStatus: (line: string) => void,
  message: string,
  progressText = "PNG 출력 실패",
): void {
  setJobState({
    id: "failed-export",
    kind: "page-export",
    status: "failed",
    progressText,
    detail: message,
  });
  pushStatus(message);
}

export function resolveInpaintingTarget(
  currentChapter: ChapterSnapshot | null,
  selectedPage: MangaPage | null,
  scope: InpaintingScope,
): InpaintingActionTarget | null {
  if (!currentChapter) {
    return null;
  }
  const page = scope === "page" ? selectedPage : null;
  const pageId = page?.id ?? null;
  if (scope === "page" && !pageId) {
    return null;
  }
  return {
    chapterId: currentChapter.id,
    page,
    pageId,
  };
}

export async function saveDirtyChanges(
  dirty: boolean,
  saveNow: () => Promise<void>,
): Promise<unknown> {
  if (!dirty) {
    return null;
  }
  return saveNow();
}

export async function refreshLibraryWithStatus(
  refreshLibrary: () => Promise<void>,
  pushStatus: (line: string) => void,
  fallback = "보관함 목록을 새로고침하지 못했습니다.",
): Promise<void> {
  try {
    await refreshLibrary();
  } catch (error) {
    console.error(error);
    pushStatus(formatErrorMessage(error, fallback));
  }
}
