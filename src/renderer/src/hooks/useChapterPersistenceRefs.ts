import { useMemo, useRef } from "react";
import type {
  ChapterPersistenceRefs,
  SaveReason,
  ServerPageVersion,
} from "./chapterPersistenceTypes";

export function useChapterPersistenceRefs(): ChapterPersistenceRefs {
  const blockedAutoSaveVersionRef = useRef<number | null>(null);
  const dirtyPageIdsRef = useRef<Set<string>>(new Set());
  const dirtyVersionRef = useRef(0);
  const lastSaveErrorRef = useRef<{
    message: string;
    shownAt: number;
  } | null>(null);
  const saveAgainRequestedRef = useRef(false);
  const saveAgainReasonRef = useRef<SaveReason | null>(null);
  const saveInFlightRef = useRef(false);
  const saveQueuePromiseRef = useRef<Promise<void> | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const serverVersionByPageIdRef = useRef<Map<string, ServerPageVersion>>(
    new Map(),
  );
  const serverVersionChapterIdRef = useRef<string | null>(null);
  return useMemo(
    () => ({
      blockedAutoSaveVersionRef,
      dirtyPageIdsRef,
      dirtyVersionRef,
      lastSaveErrorRef,
      saveAgainReasonRef,
      saveAgainRequestedRef,
      saveInFlightRef,
      saveQueuePromiseRef,
      saveTimerRef,
      serverVersionByPageIdRef,
      serverVersionChapterIdRef,
    }),
    [
      blockedAutoSaveVersionRef,
      dirtyPageIdsRef,
      dirtyVersionRef,
      lastSaveErrorRef,
      saveAgainReasonRef,
      saveAgainRequestedRef,
      saveInFlightRef,
      saveQueuePromiseRef,
      saveTimerRef,
      serverVersionByPageIdRef,
      serverVersionChapterIdRef,
    ],
  );
}
