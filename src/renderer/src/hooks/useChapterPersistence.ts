import React, { useCallback, useRef, useState } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/types";
import { hashTranslationBlocks } from "../../../shared/blockFingerprint";
import { clampBbox } from "../../../shared/geometry";
import { mangaGateway } from "../api/mangaGateway";

type UseChapterPersistenceOptions = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  onSaveError?: (message: string) => void;
  setCurrentChapter: React.Dispatch<
    React.SetStateAction<ChapterSnapshot | null>
  >;
};

type ServerPageVersion = {
  updatedAt: string;
  blocksHash: string;
};

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

export function useChapterPersistence({
  currentChapter,
  currentChapterRef,
  onSaveError,
  setCurrentChapter,
}: UseChapterPersistenceOptions): {
  clearDirtyTracking: () => void;
  resetSaveBaseline: (chapter?: ChapterSnapshot | null) => void;
  dirty: boolean;
  dirtyPageIdsRef: React.MutableRefObject<Set<string>>;
  markDirty: (pageId?: string) => void;
  replaceDirtyPageIds: (pageIds: string[]) => void;
  saveNow: () => Promise<void>;
} {
  const [dirty, setDirty] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const dirtyVersionRef = useRef(0);
  const dirtyPageIdsRef = useRef<Set<string>>(new Set());
  const blockedAutoSaveVersionRef = useRef<number | null>(null);
  const serverVersionByPageIdRef = useRef<Map<string, ServerPageVersion>>(
    new Map(),
  );
  const serverVersionChapterIdRef = useRef<string | null>(null);

  const syncServerPageVersions = useCallback(
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
    [],
  );

  React.useEffect(() => {
    syncServerPageVersions(currentChapter, { preserveDirtyPages: true });
  }, [currentChapter, syncServerPageVersions]);

  const syncSavedPageVersion = useCallback(
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
    [],
  );

  const persistPageBlocks = useCallback(
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
    [syncSavedPageVersion],
  );

  const persistChapter = useCallback(
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
      if (
        options.syncState !== false &&
        currentChapterRef.current?.id === saved.id
      ) {
        currentChapterRef.current = saved;
        setCurrentChapter(saved);
      }
      return saved;
    },
    [currentChapterRef, persistPageBlocks, setCurrentChapter],
  );

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
    onSaveError,
    persistChapter,
    setCurrentChapter,
  ]);

  const markDirty = useCallback(
    (pageId?: string) => {
      dirtyVersionRef.current += 1;
      blockedAutoSaveVersionRef.current = null;
      if (pageId) {
        if (!dirtyPageIdsRef.current.has(pageId)) {
          const page = currentChapterRef.current?.pages.find(
            (candidate) => candidate.id === pageId,
          );
          if (page && !serverVersionByPageIdRef.current.has(pageId)) {
            serverVersionByPageIdRef.current.set(pageId, {
              updatedAt: page.updatedAt,
              blocksHash: hashTranslationBlocks(page.blocks),
            });
            serverVersionChapterIdRef.current =
              currentChapterRef.current?.id ??
              serverVersionChapterIdRef.current;
          }
        }
        dirtyPageIdsRef.current = new Set([...dirtyPageIdsRef.current, pageId]);
      }
      setDirty(true);
    },
    [currentChapterRef],
  );

  const resetSaveBaseline = useCallback(
    (
      chapter: ChapterSnapshot | null | undefined = currentChapterRef.current,
    ) => {
      syncServerPageVersions(chapter ?? null);
    },
    [currentChapterRef, syncServerPageVersions],
  );

  const clearDirtyTracking = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    blockedAutoSaveVersionRef.current = null;
    dirtyPageIdsRef.current.clear();
    resetSaveBaseline();
    setDirty(false);
  }, [resetSaveBaseline]);

  const replaceDirtyPageIds = useCallback((pageIds: string[]) => {
    if (pageIds.length === 0) {
      blockedAutoSaveVersionRef.current = null;
    }
    dirtyPageIdsRef.current = new Set(pageIds);
    setDirty(pageIds.length > 0);
  }, []);

  const saveNow = useCallback(async () => {
    const chapter = currentChapterRef.current;
    if (!chapter) {
      return;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    blockedAutoSaveVersionRef.current = null;
    await persistChapter(chapter);
    dirtyPageIdsRef.current.clear();
    syncServerPageVersions(currentChapterRef.current);
    setDirty(false);
  }, [currentChapterRef, persistChapter, syncServerPageVersions]);

  return {
    clearDirtyTracking,
    resetSaveBaseline,
    dirty,
    dirtyPageIdsRef,
    markDirty,
    replaceDirtyPageIds,
    saveNow,
  };
}
