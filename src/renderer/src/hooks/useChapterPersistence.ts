import React, { useCallback, useRef, useState } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/types";
import { clampBbox } from "../../../shared/geometry";

type UseChapterPersistenceOptions = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  setCurrentChapter: React.Dispatch<React.SetStateAction<ChapterSnapshot | null>>;
};

function isStalePageSaveError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("페이지가 다른 작업으로 갱신되었습니다");
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
          saved = await window.mangaApi.savePageBlocks({
            chapterId: saved.id,
            pageId,
            baseUpdatedAt: page.updatedAt,
            blocks: serializePageBlocks(page)
          });
        } catch (error) {
          if (!isStalePageSaveError(error)) {
            throw error;
          }

          const latest = await window.mangaApi.openChapter(saved.id);
          const latestPage = latest.pages.find((candidate) => candidate.id === pageId);
          if (!latestPage) {
            throw error;
          }
          saved = await window.mangaApi.savePageBlocks({
            chapterId: latest.id,
            pageId,
            baseUpdatedAt: latestPage.updatedAt,
            blocks: serializePageBlocks(page)
          });
        }
      }
      if (options.syncState !== false && currentChapterRef.current?.id === saved.id) {
        currentChapterRef.current = saved;
        setCurrentChapter(saved);
      }
      return saved;
    },
    [currentChapterRef, setCurrentChapter]
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
      } finally {
        saveTimerRef.current = null;
      }
    }, 400);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [currentChapter, currentChapterRef, dirty, persistChapter, setCurrentChapter]);

  const markDirty = useCallback((pageId?: string) => {
    dirtyVersionRef.current += 1;
    if (pageId) {
      dirtyPageIdsRef.current = new Set([...dirtyPageIdsRef.current, pageId]);
    }
    setDirty(true);
  }, []);

  const clearDirtyTracking = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    dirtyPageIdsRef.current.clear();
    setDirty(false);
  }, []);

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
    setDirty(false);
  }, [currentChapterRef, persistChapter]);

  return {
    clearDirtyTracking,
    dirty,
    dirtyPageIdsRef,
    markDirty,
    replaceDirtyPageIds,
    saveNow
  };
}
