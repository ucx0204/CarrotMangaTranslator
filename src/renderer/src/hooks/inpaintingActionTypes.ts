import type { Dispatch, SetStateAction } from "react";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { RegionSelectionState } from "../lib/appHelpers";
import { formatErrorMessage } from "../lib/appHelpers";
import type { ChapterSnapshot, MangaPage } from "./hookLibraryTypes";

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
  hideInpaintingGuide: boolean;
  jobActive: boolean;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  patternMaskStrokes: InpaintingMaskStroke[];
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  saveNow: () => Promise<void>;
  selectedPage: MangaPage | null;
  setInpaintingGuideOpen: Dispatch<SetStateAction<boolean>>;
  setInpaintingMode: Dispatch<SetStateAction<boolean>>;
  setInpaintingTool: Dispatch<
    SetStateAction<"none" | "brush" | "eraser" | "picker" | "mask">
  >;
  setJobState: Dispatch<SetStateAction<JobState>>;
  setPatternMaskStrokesByPage: Dispatch<
    SetStateAction<Record<string, InpaintingMaskStroke[]>>
  >;
  setPeekOriginal: Dispatch<SetStateAction<boolean>>;
  setRegionSelection: Dispatch<SetStateAction<RegionSelectionState | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setShowBlockChrome: Dispatch<SetStateAction<boolean>>;
  setShowTextBlocks: Dispatch<SetStateAction<boolean>>;
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
    kind: "inpainting",
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
