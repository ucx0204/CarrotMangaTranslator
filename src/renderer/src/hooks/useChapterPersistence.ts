import React, { useCallback, useRef, useState } from "react";
import type { ChapterSnapshot } from "../../../shared/types";
import { clampBbox } from "../../../shared/geometry";

type UseChapterPersistenceOptions = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  setCurrentChapter: React.Dispatch<React.SetStateAction<ChapterSnapshot | null>>;
};

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
      let saved = chapter;
      for (const pageId of dirtyPageIds) {
        const page = chapter.pages.find((candidate) => candidate.id === pageId);
        if (!page) {
          continue;
        }
        saved = await window.mangaApi.savePageBlocks({
          chapterId: saved.id,
          pageId,
          blocks: page.blocks.map((block) => ({
            ...block,
            bbox: clampBbox(block.bbox),
            renderBbox: block.renderBbox ? clampBbox(block.renderBbox) : undefined
          }))
        });
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
