import React, { useCallback, useRef, useState } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import { hashTranslationBlocks } from "../../../shared/blockFingerprint";
import { clampBbox } from "../../../shared/geometry";
import { mangaGateway } from "../api/mangaGateway";
import { useDirtyTrackingActions } from "./useChapterPersistenceActions";
import type {
  ChapterPersistenceRefs,
  ChapterPersistenceResult,
  PersistChapter,
  ServerPageVersion,
  ServerVersionSyncActions,
  UseChapterPersistenceOptions,
} from "./chapterPersistenceTypes";

function isStalePageSaveError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("페이지가 다른 작업으로 갱신되었습니다")
  );
}

function isPageSaveConflictError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (isStalePageSaveError(error) || error.message.includes("페이지 저장 충돌"))
  );
}

function makeStalePageSaveConflictError(): Error {
  return new Error(
    "페이지 저장 충돌이 발생했습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.",
  );
}

function serializePageBlocks(page: MangaPage): MangaPage["blocks"] {
  return page.blocks.map((block) => ({
    ...block,
    bbox: clampBbox(block.bbox),
    renderBbox: block.renderBbox ? clampBbox(block.renderBbox) : undefined,
  }));
}

function collectDirtyPages(
  chapter: ChapterSnapshot,
  dirtyPageIds: string[],
): MangaPage[] {
  const pagesById = new Map(chapter.pages.map((page) => [page.id, page]));
  return dirtyPageIds
    .map((pageId) => pagesById.get(pageId))
    .filter((page): page is MangaPage => Boolean(page));
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

  useAutosaveEffect({
    currentChapter,
    currentChapterRef,
    dirty,
    onSaveError,
    persistChapter,
    refs,
    setCurrentChapter,
    setDirty,
  });

  const actions = useDirtyTrackingActions({
    currentChapterRef,
    persistChapter,
    refs,
    setDirty,
    syncServerPageVersions,
  });

  return {
    ...actions,
    dirty,
    dirtyPageIdsRef,
  };
}

function useChapterPersistenceRefs(): ChapterPersistenceRefs {
  return {
    blockedAutoSaveVersionRef: useRef<number | null>(null),
    dirtyPageIdsRef: useRef<Set<string>>(new Set()),
    dirtyVersionRef: useRef(0),
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
  const { serverVersionByPageIdRef } = refs;
  return useCallback<PersistPageBlocks>(
    async (chapter: ChapterSnapshot, page: MangaPage) => {
      const baseVersion = serverVersionByPageIdRef.current.get(page.id);
      try {
        const saved = await mangaGateway.savePageBlocks({
          chapterId: chapter.id,
          pageId: page.id,
          baseUpdatedAt: baseVersion?.updatedAt ?? page.updatedAt,
          baseBlocksHash:
            baseVersion?.blocksHash ?? hashTranslationBlocks(page.blocks),
          blocks: serializePageBlocks(page),
        });
        syncSavedPageVersion(saved, page.id);
        return saved;
      } catch (error) {
        if (!isStalePageSaveError(error)) {
          throw error;
        }
        throw makeStalePageSaveConflictError();
      }
    },
    [serverVersionByPageIdRef, syncSavedPageVersion],
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
      options: { syncState?: boolean } = {},
    ): Promise<ChapterSnapshot> => {
      const dirtyPages = collectDirtyPages(chapter, [
        ...dirtyPageIdsRef.current,
      ]);
      let saved = chapter;
      for (const page of dirtyPages) {
        saved = await persistPageBlocks(saved, page);
      }
      saved = preserveChapterPageOrder(saved, chapter.pageOrder);
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
  currentChapterRef,
  dirty,
  onSaveError,
  persistChapter,
  refs,
  setCurrentChapter,
  setDirty,
}: UseChapterPersistenceOptions & {
  dirty: boolean;
  persistChapter: PersistChapter;
  refs: ChapterPersistenceRefs;
  setDirty: React.Dispatch<React.SetStateAction<boolean>>;
}): void {
  const {
    blockedAutoSaveVersionRef,
    dirtyPageIdsRef,
    dirtyVersionRef,
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
        const saved = await persistChapter(currentChapter, {
          syncState: false,
        });
        if (dirtyVersionRef.current === version) {
          currentChapterRef.current = saved;
          setCurrentChapter(saved);
          dirtyPageIdsRef.current.clear();
          setDirty(false);
        }
      } catch (error) {
        if (isPageSaveConflictError(error)) {
          blockedAutoSaveVersionRef.current = version;
        }
        console.error(error);
        onSaveError?.(error instanceof Error ? error.message : String(error));
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
    currentChapterRef,
    dirty,
    blockedAutoSaveVersionRef,
    dirtyPageIdsRef,
    dirtyVersionRef,
    onSaveError,
    persistChapter,
    saveTimerRef,
    setCurrentChapter,
    setDirty,
  ]);
}
