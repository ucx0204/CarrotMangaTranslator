import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import { hashTranslationBlocks } from "../../../shared/blockFingerprint";
import { libraryGateway as mangaGateway } from "../api/libraryGateway";
import { notifySaveErrorDeduped } from "./chapterSaveErrorNotification";
import { collectPageBlockUpdates } from "./chapterPersistencePayload";
import { useDirtyTrackingActions } from "./useChapterPersistenceActions";
import { useEventCallback } from "./useEventCallback";
import { useChapterPersistenceRefs } from "./useChapterPersistenceRefs";
import {
  useChapterSaveStatusActions,
  useChapterSaveStatusRunner,
} from "./useChapterSaveStatus";
import { useQueuedChapterSave } from "./useQueuedChapterSave";
import type {
  ChapterSaveStatus,
  ChapterPersistenceRefs,
  ChapterPersistenceResult,
  PersistChapter,
  QueuedSaveRunner,
  SaveReason,
  ServerPageVersion,
  ServerVersionSyncActions,
  UseChapterPersistenceOptions,
} from "./chapterPersistenceTypes";

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

type PersistPagesBlocks = (
  chapter: ChapterSnapshot,
  pageIds: string[],
  context: { dirtyVersion?: number; saveReason?: SaveReason },
) => Promise<ChapterSnapshot>;

type PageVersionCache = WeakMap<MangaPage, ServerPageVersion>;

export type { UseChapterPersistenceOptions } from "./chapterPersistenceTypes";

export function useChapterPersistence({
  currentChapter,
  currentChapterRef,
  onSaveError,
  setCurrentChapter,
}: UseChapterPersistenceOptions): ChapterPersistenceResult {
  const [dirty, setDirty] = useState(false);
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const [saveStatus, setSaveStatus] = useState<ChapterSaveStatus>("idle");
  const refs = useChapterPersistenceRefs();
  const notifySaveError = useEventCallback((message: string) => {
    onSaveError?.(message);
  });
  const pageVersionRef = useRef<PageVersionCache>(new WeakMap());
  const { dirtyPageIdsRef } = refs;
  const { syncSavedPageVersion, syncServerPageVersions } =
    useServerVersionSyncActions(refs, pageVersionRef);
  useSyncServerVersionsEffect(currentChapter, syncServerPageVersions);

  const persistPagesBlocks = usePersistPagesBlocks({
    refs,
    syncSavedPageVersion,
  });
  const persistChapter = usePersistChapter({
    currentChapterRef,
    persistPagesBlocks,
    refs,
    setCurrentChapter,
  });
  const baseRunQueuedSave = useQueuedChapterSave({
    currentChapterRef,
    persistChapter,
    refs,
    setCurrentChapter,
    setDirty,
    syncServerPageVersions,
  });
  const runQueuedSave = useChapterSaveStatusRunner({
    baseRunQueuedSave,
    isConflictError: isPageSaveConflictError,
    refs,
    setSaveStatus,
  });

  const chapterId = currentChapter?.id ?? null;
  React.useEffect(() => {
    setSaveStatus("idle");
  }, [chapterId]);

  useAutosaveEffect({
    currentChapter,
    dirty,
    dirtyVersion,
    onSaveError: notifySaveError,
    refs,
    runQueuedSave,
  });

  const baseActions = useDirtyTrackingActions({
    currentChapterRef,
    refs,
    runQueuedSave,
    setDirty,
    setDirtyVersion,
    syncServerPageVersions,
  });
  const actions = useChapterSaveStatusActions(baseActions, setSaveStatus);

  return useMemo(
    () => ({
      ...actions,
      dirty,
      dirtyPageIdsRef,
      saveStatus,
      syncSavedPageVersion,
    }),
    [actions, dirty, dirtyPageIdsRef, saveStatus, syncSavedPageVersion],
  );
}

function useServerVersionSyncActions(
  {
    dirtyPageIdsRef,
    serverVersionByPageIdRef,
    serverVersionChapterIdRef,
  }: ChapterPersistenceRefs,
  pageVersionRef: React.MutableRefObject<PageVersionCache>,
): ServerVersionSyncActions {
  const syncServerPageVersions = useCallback(
    (
      chapter: ChapterSnapshot | null,
      options: { preserveDirtyPages?: boolean } = {},
    ) => {
      if (!chapter) {
        serverVersionByPageIdRef.current.clear();
        pageVersionRef.current = new WeakMap();
        serverVersionChapterIdRef.current = null;
        return;
      }

      const chapterChanged = serverVersionChapterIdRef.current !== chapter.id;
      if (chapterChanged) {
        serverVersionByPageIdRef.current.clear();
        pageVersionRef.current = new WeakMap();
        serverVersionChapterIdRef.current = chapter.id;
      }

      for (const page of chapter.pages) {
        if (
          !chapterChanged &&
          options.preserveDirtyPages &&
          dirtyPageIdsRef.current.has(page.id)
        ) {
          continue;
        }
        let version = pageVersionRef.current.get(page);
        if (!version || version.updatedAt !== page.updatedAt) {
          version = {
            updatedAt: page.updatedAt,
            blocksHash: hashTranslationBlocks(page.blocks),
          };
          pageVersionRef.current.set(page, version);
        }
        serverVersionByPageIdRef.current.set(page.id, version);
      }
    },
    [
      dirtyPageIdsRef,
      pageVersionRef,
      serverVersionByPageIdRef,
      serverVersionChapterIdRef,
    ],
  );

  const syncSavedPageVersion = useCallback(
    (chapter: ChapterSnapshot, pageId: string) => {
      const savedPage = chapter.pages.find(
        (candidate) => candidate.id === pageId,
      );
      if (savedPage) {
        const version = {
          updatedAt: savedPage.updatedAt,
          blocksHash: hashTranslationBlocks(savedPage.blocks),
        };
        pageVersionRef.current.set(savedPage, version);
        serverVersionByPageIdRef.current.set(pageId, version);
        serverVersionChapterIdRef.current = chapter.id;
      }
    },
    [pageVersionRef, serverVersionByPageIdRef, serverVersionChapterIdRef],
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

function usePersistPagesBlocks({
  refs,
  syncSavedPageVersion,
}: {
  refs: ChapterPersistenceRefs;
  syncSavedPageVersion: ServerVersionSyncActions["syncSavedPageVersion"];
}): PersistPagesBlocks {
  const { t } = useTranslation("renderer");
  const { serverVersionByPageIdRef } = refs;
  return useCallback<PersistPagesBlocks>(
    async (
      chapter: ChapterSnapshot,
      pageIds: string[],
      context: { dirtyVersion?: number; saveReason?: SaveReason },
    ) => {
      const pages = collectPageBlockUpdates(
        chapter,
        pageIds,
        serverVersionByPageIdRef.current,
      );
      if (pages.length === 0) {
        return chapter;
      }
      try {
        const saved = await mangaGateway.savePagesBlocks({
          chapterId: chapter.id,
          dirtyVersion: context.dirtyVersion,
          saveReason: context.saveReason,
          pages,
        });
        for (const page of pages) {
          syncSavedPageVersion(saved, page.pageId);
        }
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
  persistPagesBlocks,
  refs,
  setCurrentChapter,
}: {
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  persistPagesBlocks: PersistPagesBlocks;
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
      const sourceChapter =
        currentChapterRef.current?.id === chapter.id
          ? currentChapterRef.current
          : chapter;
      let saved = await persistPagesBlocks(sourceChapter, dirtyPageIds, {
        dirtyVersion: options.dirtyVersion,
        saveReason: options.saveReason,
      });
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
    [currentChapterRef, dirtyPageIdsRef, persistPagesBlocks, setCurrentChapter],
  );
}

function useAutosaveEffect({
  currentChapter,
  dirty,
  dirtyVersion,
  onSaveError,
  refs,
  runQueuedSave,
}: {
  currentChapter: ChapterSnapshot | null;
  dirty: boolean;
  dirtyVersion: number;
  onSaveError?: UseChapterPersistenceOptions["onSaveError"];
  refs: ChapterPersistenceRefs;
  runQueuedSave: QueuedSaveRunner;
}): void {
  const { blockedAutoSaveVersionRef, lastSaveErrorRef, saveTimerRef } = refs;
  const chapterId = currentChapter?.id ?? null;
  React.useEffect(() => {
    if (!dirty || !chapterId) {
      return;
    }
    if (blockedAutoSaveVersionRef.current === dirtyVersion) {
      return;
    }

    const version = dirtyVersion;
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
    blockedAutoSaveVersionRef,
    chapterId,
    dirty,
    dirtyVersion,
    lastSaveErrorRef,
    onSaveError,
    runQueuedSave,
    saveTimerRef,
  ]);
}
