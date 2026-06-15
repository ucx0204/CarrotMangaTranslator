import React, { useCallback, useRef, useState } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/types";
import { clampBbox } from "../../../shared/geometry";
import { mangaGateway } from "../api/mangaGateway";

type UseChapterPersistenceOptions = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  onSaveError?: (message: string) => void;
  setCurrentChapter: React.Dispatch<React.SetStateAction<ChapterSnapshot | null>>;
};

function isStalePageSaveError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("페이지가 다른 작업으로 갱신되었습니다");
}

function makeStalePageSaveConflictError(): Error {
  return new Error("페이지 저장 충돌이 발생했습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.");
}

function serializePageBlocks(page: MangaPage): MangaPage["blocks"] {
  return page.blocks.map((block) => ({
    ...block,
    bbox: clampBbox(block.bbox),
    renderBbox: block.renderBbox ? clampBbox(block.renderBbox) : undefined
  }));
}

export function useChapterPersistence({
  currentChapter,
  currentChapterRef,
  onSaveError,
  setCurrentChapter
}: UseChapterPersistenceOptions): {
  clearDirtyTracking: () => void;
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
  const serverUpdatedAtByPageIdRef = useRef<Map<string, string>>(new Map());
  const serverVersionChapterIdRef = useRef<string | null>(null);

  const syncServerPageVersions = useCallback(
    (chapter: ChapterSnapshot | null, options: { preserveDirtyPages?: boolean } = {}) => {
      if (!chapter) {
        serverUpdatedAtByPageIdRef.current.clear();
        serverVersionChapterIdRef.current = null;
        return;
      }

      if (serverVersionChapterIdRef.current !== chapter.id) {
        serverUpdatedAtByPageIdRef.current.clear();
        serverVersionChapterIdRef.current = chapter.id;
      }

      for (const page of chapter.pages) {
        if (options.preserveDirtyPages && dirtyPageIdsRef.current.has(page.id)) {
          continue;
        }
        serverUpdatedAtByPageIdRef.current.set(page.id, page.updatedAt);
      }
    },
    []
  );

  React.useEffect(() => {
    syncServerPageVersions(currentChapter, { preserveDirtyPages: true });
  }, [currentChapter, syncServerPageVersions]);

  const syncSavedPageVersion = useCallback((chapter: ChapterSnapshot, pageId: string) => {
    const savedPage = chapter.pages.find((candidate) => candidate.id === pageId);
    if (savedPage) {
      serverUpdatedAtByPageIdRef.current.set(pageId, savedPage.updatedAt);
      serverVersionChapterIdRef.current = chapter.id;
    }
  }, []);

  const persistChapter = useCallback(
    async (chapter: ChapterSnapshot, options: { syncState?: boolean } = {}): Promise<ChapterSnapshot> => {
      const dirtyPageIds = [...dirtyPageIdsRef.current];
      const dirtyPages = new Map(
        dirtyPageIds
          .map((pageId) => chapter.pages.find((candidate) => candidate.id === pageId))
          .filter((page): page is MangaPage => Boolean(page))
          .map((page) => [page.id, page])
      );
      let saved = chapter;
      for (const pageId of dirtyPageIds) {
        const page = dirtyPages.get(pageId);
        if (!page) {
          continue;
        }
        try {
          saved = await mangaGateway.savePageBlocks({
            chapterId: saved.id,
            pageId,
            baseUpdatedAt: serverUpdatedAtByPageIdRef.current.get(pageId) ?? page.updatedAt,
            blocks: serializePageBlocks(page)
          });
          syncSavedPageVersion(saved, pageId);
        } catch (error) {
          if (!isStalePageSaveError(error)) {
            throw error;
          }
          throw makeStalePageSaveConflictError();
        }
      }
      if (options.syncState !== false && currentChapterRef.current?.id === saved.id) {
        currentChapterRef.current = saved;
        setCurrentChapter(saved);
      }
      return saved;
    },
    [currentChapterRef, setCurrentChapter, syncSavedPageVersion]
  );

  React.useEffect(() => {
    if (!dirty || !currentChapter) {
      return;
    }

    const version = dirtyVersionRef.current;
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        const saved = await persistChapter(currentChapter, { syncState: false });
        if (dirtyVersionRef.current === version) {
          currentChapterRef.current = saved;
          setCurrentChapter(saved);
          dirtyPageIdsRef.current.clear();
          setDirty(false);
        }
      } catch (error) {
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
  }, [currentChapter, currentChapterRef, dirty, onSaveError, persistChapter, setCurrentChapter]);

  const markDirty = useCallback((pageId?: string) => {
    dirtyVersionRef.current += 1;
    if (pageId) {
      if (!dirtyPageIdsRef.current.has(pageId)) {
        const page = currentChapterRef.current?.pages.find((candidate) => candidate.id === pageId);
        if (page && !serverUpdatedAtByPageIdRef.current.has(pageId)) {
          serverUpdatedAtByPageIdRef.current.set(pageId, page.updatedAt);
          serverVersionChapterIdRef.current = currentChapterRef.current?.id ?? serverVersionChapterIdRef.current;
        }
      }
      dirtyPageIdsRef.current = new Set([...dirtyPageIdsRef.current, pageId]);
    }
    setDirty(true);
  }, [currentChapterRef]);

  const clearDirtyTracking = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    dirtyPageIdsRef.current.clear();
    syncServerPageVersions(currentChapterRef.current);
    setDirty(false);
  }, [currentChapterRef, syncServerPageVersions]);

  const replaceDirtyPageIds = useCallback((pageIds: string[]) => {
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
    await persistChapter(chapter);
    dirtyPageIdsRef.current.clear();
    syncServerPageVersions(currentChapterRef.current);
    setDirty(false);
  }, [currentChapterRef, persistChapter, syncServerPageVersions]);

  return {
    clearDirtyTracking,
    dirty,
    dirtyPageIdsRef,
    markDirty,
    replaceDirtyPageIds,
    saveNow
  };
}
