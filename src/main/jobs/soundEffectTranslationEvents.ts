import type { JobEvent } from "../../shared/jobTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { StartSoundEffectTranslationResult } from "../../shared/analysisTypes";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";
import { countChapterPendingSoundEffectRegions } from "./soundEffectTranslationTargets";

type EmitJobEvent = (event: JobEvent) => void;

export function finishSoundEffectTranslation(
  {
    emit,
    id,
    state,
  }: Pick<SoundEffectTranslationJobInput, "emit" | "id" | "state">,
  chapter: ChapterSnapshot,
  requestedRegionCount: number,
  pageTotal: number,
): StartSoundEffectTranslationResult {
  const remainingRegionCount = countChapterPendingSoundEffectRegions(chapter);
  const failedRequested = requestedRegionCount - state.translatedRegionCount;
  const status = failedRequested > 0 ? "partial" : "completed";
  emitSoundEffectTerminal(
    id,
    emit,
    status,
    pageTotal,
    state.translatedRegionCount,
  );
  return {
    status,
    chapter,
    createdBlocksByPage: state.createdBlocksByPage,
    translatedRegionCount: state.translatedRegionCount,
    remainingRegionCount,
    ...(state.warnings.length > 0 ? { warnings: state.warnings } : {}),
  };
}

export function emitSoundEffectPageRunning(
  id: string,
  emit: EmitJobEvent,
  page: MangaPage,
  pageIndex: number,
  pageTotal: number,
): void {
  emit({
    id,
    kind: "sound-effect-translation",
    status: "running",
    progressText: "효과음 번역 중",
    phase: "page_running",
    progressCurrent: pageIndex,
    progressTotal: pageTotal,
    pageIndex,
    pageTotal,
    detail: page.name,
  });
}

export function emitSoundEffectPageDone(
  id: string,
  emit: EmitJobEvent,
  pageIndex: number,
  pageTotal: number,
  translatedCount: number,
): void {
  emit({
    id,
    kind: "sound-effect-translation",
    status: "running",
    progressText: "효과음 페이지 번역 완료",
    phase: "page_done",
    progressCurrent: pageIndex + 1,
    progressTotal: pageTotal,
    pageIndex,
    pageTotal,
    detail: `${translatedCount}개 번역`,
  });
}

export function emitSoundEffectTerminal(
  id: string,
  emit: EmitJobEvent,
  status: "completed" | "partial" | "cancelled",
  pageTotal: number,
  translatedCount: number,
): void {
  emit({
    id,
    kind: "sound-effect-translation",
    status,
    progressText:
      status === "cancelled"
        ? "효과음 번역 취소됨"
        : status === "partial"
          ? "효과음 번역 일부 완료"
          : "효과음 번역 완료",
    phase: status === "completed" ? "done" : status,
    progressCurrent: pageTotal,
    progressTotal: pageTotal,
    pageTotal,
    detail: `${translatedCount}개 번역`,
  });
}
