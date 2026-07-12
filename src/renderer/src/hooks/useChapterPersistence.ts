import React, { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import { hashTranslationBlocks } from "../../../shared/blockFingerprint";
import { clampBbox } from "../../../shared/geometry";
import { mangaGateway } from "../api/mangaGateway";
import { useDirtyTrackingActions } from "./useChapterPersistenceActions";
import { useQueuedChapterSave } from "./useQueuedChapterSave";
import type {
  ChapterPersistenceRefs,
  ChapterPersistenceResult,
  PersistChapter,
  QueuedSaveRunner,
  SaveReason,
  ServerPageVersion,
  ServerVersionSyncActions,
  UseChapterPersistenceOptions,
} from "./chapterPersistenceTypes";

const SAVE_ERROR_DEDUPE_MS = 5000;
const STALE_PAGE_SAVE_ERROR_CODE = "STALE_PAGE_SAVE";
const PAGE_SAVE_CONFLICT_ERROR_CODE = "PAGE_SAVE_CONFLICT";

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function isStalePageSaveError(error: unknown): boolean {
  return (
    errorCode(error) === STALE_PAGE_SAVE_ERROR_CODE ||
    (error instanceof Error &&
      (error.message.includes(`[${STALE_PAGE_SAVE_ERROR_CODE}]`) ||
        error.message.includes("페이지가 다른 작업으로 갱신되었습니다")))
  );
}

function isPageSaveConflictError(error: unknown): boolean {
  return (
    errorCode(error) === PAGE_SAVE_CONFLICT_ERROR_CODE ||
    (error instanceof Error &&
      (isStalePageSaveError(error) ||
        error.message.includes(`[${PAGE_SAVE_CONFLICT_ERROR_CODE}]`) ||
        error.message.includes("페이지 저장 충돌")))
  );
}

function makeStalePageSaveConflictError(t: TFunction<"renderer">): Error {
  const error = new Error(t("chapter.saveConflict"));
  Object.assign(error, { code: PAGE_SAVE_CONFLICT_ERROR_CODE });
  return error;
}

function serializePageBlocks(page: MangaPage): MangaPage["blocks"] {
  return page.blocks.map((block) => ({
    ...block,
    bbox: clampBbox(block.bbox),
    renderBbox: block.renderBbox ? clampBbox(block.renderBbox) : undefined,
  }));
}

function preserveChapterPageOrder(
  chapter: ChapterSnapshot,
  pageOrder: string[],
): ChapterSnapshot {
  return {
    ...chapter,
    pageOrder,
    pages: reorderPagesByIdOrder(chapter.pages, pageOrder),
  };
}

function reorderPagesByIdOrder(
  pages: MangaPage[],
  pageOrder: string[],
): MangaPage[] {
  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const ordered = pageOrder.flatMap((pageId) => {
    const page = pageMap.get(pageId);
    return page ? [page] : [];
  });
  const orderedIds = new Set(ordered.map((page) => page.id));
  return [...ordered, ...pages.filter((page) => !orderedIds.has(page.id))];
}

type PersistPageBlocks = (
  chapter: ChapterSnapshot,
  page: MangaPage,
  context: { dirtyVersion?: number; saveReason?: SaveReason },
) => Promise<ChapterSnapshot>;

export type {
  ChapterPersistenceRefs,
  DirtyTrackingActions,
  PersistChapter,
  ServerVersionSyncActions,
  UseChapterPersistenceOptions,
} from "./chapterPersistenceTypes";

export function useChapterPersistence({
  currentChapter,
  currentChapterRef,
  onSaveError,
  setCurrentChapter,
}: UseChapterPersistenceOptions): ChapterPersistenceResult {
  const [dirty, setDirty] = useState(false);
  const refs = useChapterPersistenceRefs();
  const { dirtyPageIdsRef } = refs;
  const { syncSavedPageVersion, syncServerPageVersions } =
    useServerVersionSyncActions(refs);
  useSyncServerVersionsEffect(currentChapter, syncServerPageVersions);

  const persistPageBlocks = usePersistPageBlocks({
    refs,
    syncSavedPageVersion,
  });
  const persistChapter = usePersistChapter({
    currentChapterRef,
    persistPageBlocks,
    refs,
    setCurrentChapter,
  });
  const runQueuedSave = useQueuedChapterSave({
    currentChapterRef,
    persistChapter,
    refs,
    setCurrentChapter,
    setDirty,
    syncServerPageVersions,
  });

  useAutosaveEffect({
    currentChapter,
    dirty,
    onSaveError,
    refs,
    runQueuedSave,
  });

  const actions = useDirtyTrackingActions({
    currentChapterRef,
    refs,
    runQueuedSave,
    setDirty,
    syncServerPageVersions,
  });

  return {
    ...actions,
    dirty,
    dirtyPageIdsRef,
    syncSavedPageVersion,
  };
}

function useChapterPersistenceRefs(): ChapterPersistenceRefs {
  return {
    blockedAutoSaveVersionRef: useRef<number | null>(null),
    dirtyPageIdsRef: useRef<Set<string>>(new Set()),
    dirtyVersionRef: useRef(0),
    lastSaveErrorRef: useRef<{
      message: string;
      shownAt: number;
    } | null>(null),
    saveAgainRequestedRef: useRef(false),
    saveAgainReasonRef: useRef<SaveReason | null>(null),
    saveInFlightRef: useRef(false),
    saveQueuePromiseRef: useRef<Promise<void> | null>(null),
    saveTimerRef: useRef<number | null>(null),
    serverVersionByPageIdRef: useRef<Map<string, ServerPageVersion>>(new Map()),
    serverVersionChapterIdRef: useRef<string | null>(null),
  };
}

function useServerVersionSyncActions({
  dirtyPageIdsRef,
  serverVersionByPageIdRef,
  serverVersionChapterIdRef,
}: ChapterPersistenceRefs): ServerVersionSyncActions {
  const syncServerPageVersions = useCallback<
    ServerVersionSyncActions["syncServerPageVersions"]
  >(
    (
      chapter: ChapterSnapshot | null,
      options: { preserveDirtyPages?: boolean } = {},
    ) => {
      if (!chapter) {
        serverVersionByPageIdRef.current.clear();
        serverVersionChapterIdRef.current = null;
        return;
      }

      if (serverVersionChapterIdRef.current !== chapter.id) {
        serverVersionByPageIdRef.current.clear();
        serverVersionChapterIdRef.current = chapter.id;
      }

      for (const page of chapter.pages) {
        if (
          options.preserveDirtyPages &&
          dirtyPageIdsRef.current.has(page.id)
        ) {
          continue;
        }
        serverVersionByPageIdRef.current.set(page.id, {
          updatedAt: page.updatedAt,
          blocksHash: hashTranslationBlocks(page.blocks),
        });
      }
    },
    [dirtyPageIdsRef, serverVersionByPageIdRef, serverVersionChapterIdRef],
  );

  const syncSavedPageVersion = useCallback<
    ServerVersionSyncActions["syncSavedPageVersion"]
  >(
    (chapter: ChapterSnapshot, pageId: string) => {
      const savedPage = chapter.pages.find(
        (candidate) => candidate.id === pageId,
      );
      if (savedPage) {
        serverVersionByPageIdRef.current.set(pageId, {
          updatedAt: savedPage.updatedAt,
          blocksHash: hashTranslationBlocks(savedPage.blocks),
        });
        serverVersionChapterIdRef.current = chapter.id;
      }
    },
    [serverVersionByPageIdRef, serverVersionChapterIdRef],
  );

  return { syncSavedPageVersion, syncServerPageVersions };
}

function useSyncServerVersionsEffect(
  currentChapter: ChapterSnapshot | null,
  syncServerPageVersions: ServerVersionSyncActions["syncServerPageVersions"],
): void {
  React.useEffect(() => {
    syncServerPageVersions(currentChapter, { preserveDirtyPages: true });
  }, [currentChapter, syncServerPageVersions]);
}

function usePersistPageBlocks({
  refs,
  syncSavedPageVersion,
}: {
  refs: ChapterPersistenceRefs;
  syncSavedPageVersion: ServerVersionSyncActions["syncSavedPageVersion"];
}): PersistPageBlocks {
  const { t } = useTranslation("renderer");
  const { serverVersionByPageIdRef } = refs;
  return useCallback<PersistPageBlocks>(
    async (
      chapter: ChapterSnapshot,
      page: MangaPage,
      context: { dirtyVersion?: number; saveReason?: SaveReason },
    ) => {
      const baseVersion = serverVersionByPageIdRef.current.get(page.id);
      try {
        const saved = await mangaGateway.savePageBlocks({
          chapterId: chapter.id,
          pageId: page.id,
          baseUpdatedAt: baseVersion?.updatedAt ?? page.updatedAt,
          baseBlocksHash:
            baseVersion?.blocksHash ?? hashTranslationBlocks(page.blocks),
          dirtyVersion: context.dirtyVersion,
          saveReason: context.saveReason,
          blocks: serializePageBlocks(page),
        });
        syncSavedPageVersion(saved, page.id);
        return saved;
      } catch (error) {
        if (!isStalePageSaveError(error)) {
          throw error;
        }
        throw makeStalePageSaveConflictError(t);
      }
    },
    [serverVersionByPageIdRef, syncSavedPageVersion, t],
  );
}

function usePersistChapter({
  currentChapterRef,
  persistPageBlocks,
  refs,
  setCurrentChapter,
}: {
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  persistPageBlocks: PersistPageBlocks;
  refs: ChapterPersistenceRefs;
  setCurrentChapter: UseChapterPersistenceOptions["setCurrentChapter"];
}): PersistChapter {
  const { dirtyPageIdsRef } = refs;
  return useCallback<PersistChapter>(
    async (
      chapter: ChapterSnapshot,
      options: {
        dirtyVersion?: number;
        saveReason?: SaveReason;
        syncState?: boolean;
      } = {},
    ): Promise<ChapterSnapshot> => {
      const dirtyPageIds = [...dirtyPageIdsRef.current];
      let saved = chapter;
      for (const pageId of dirtyPageIds) {
        const sourceChapter =
          currentChapterRef.current?.id === chapter.id
            ? currentChapterRef.current
            : saved;
        const page =
          sourceChapter.pages.find((candidate) => candidate.id === pageId) ??
          saved.pages.find((candidate) => candidate.id === pageId);
        if (!page) {
          continue;
        }
        saved = await persistPageBlocks(saved, page, {
          dirtyVersion: options.dirtyVersion,
          saveReason: options.saveReason,
        });
      }
      const latestChapter =
        currentChapterRef.current?.id === chapter.id
          ? currentChapterRef.current
          : chapter;
      saved = preserveChapterPageOrder(saved, latestChapter.pageOrder);
      if (
        options.syncState !== false &&
        currentChapterRef.current?.id === saved.id
      ) {
        currentChapterRef.current = saved;
        setCurrentChapter(saved);
      }
      return saved;
    },
    [currentChapterRef, dirtyPageIdsRef, persistPageBlocks, setCurrentChapter],
  );
}

function useAutosaveEffect({
  currentChapter,
  dirty,
  onSaveError,
  refs,
  runQueuedSave,
}: {
  currentChapter: ChapterSnapshot | null;
  dirty: boolean;
  onSaveError?: UseChapterPersistenceOptions["onSaveError"];
  refs: ChapterPersistenceRefs;
  runQueuedSave: QueuedSaveRunner;
}): void {
  const {
    blockedAutoSaveVersionRef,
    dirtyVersionRef,
    lastSaveErrorRef,
    saveTimerRef,
  } = refs;
  React.useEffect(() => {
    if (!dirty || !currentChapter) {
      return;
    }
    if (blockedAutoSaveVersionRef.current === dirtyVersionRef.current) {
      return;
    }

    const version = dirtyVersionRef.current;
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        await runQueuedSave("autosave");
      } catch (error) {
        if (isPageSaveConflictError(error)) {
          blockedAutoSaveVersionRef.current = version;
        }
        console.error(error);
        notifySaveErrorDeduped(
          lastSaveErrorRef,
          onSaveError,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        saveTimerRef.current = null;
      }
    }, 400);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    currentChapter,
    dirty,
    blockedAutoSaveVersionRef,
    dirtyVersionRef,
    lastSaveErrorRef,
    onSaveError,
    runQueuedSave,
    saveTimerRef,
  ]);
}

function notifySaveErrorDeduped(
  lastSaveErrorRef: ChapterPersistenceRefs["lastSaveErrorRef"],
  onSaveError: UseChapterPersistenceOptions["onSaveError"],
  message: string,
): void {
  const now = Date.now();
  const last = lastSaveErrorRef.current;
  if (
    last &&
    last.message === message &&
    now - last.shownAt < SAVE_ERROR_DEDUPE_MS
  ) {
    return;
  }
  lastSaveErrorRef.current = { message, shownAt: now };
  onSaveError?.(message);
}
