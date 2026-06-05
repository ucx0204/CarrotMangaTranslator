import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ChapterSnapshot, LibraryIndex } from "../../../shared/types";
import type { RenameTarget } from "../components/AppModals";
import { formatErrorMessage, reorderByTarget, reorderRecordsByIdOrder } from "../lib/appHelpers";

function isSameStringOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

type UseLibraryActionsOptions = {
  askConfirm: (title: string, message: string, detail?: string) => Promise<boolean>;
  clearDirtyTracking: () => void;
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  dirty: boolean;
  library: LibraryIndex;
  pushStatus: (line: string) => void;
  saveNow: () => Promise<void>;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setLibrary: Dispatch<SetStateAction<LibraryIndex>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
};

export function useLibraryActions({
  askConfirm,
  clearDirtyTracking,
  currentChapter,
  currentChapterRef,
  dirty,
  library,
  pushStatus,
  saveNow,
  setCurrentChapter,
  setLibrary,
  setSelectedBlockId,
  setSelectedPageId
}: UseLibraryActionsOptions): {
  applyChapter: (chapter: ChapterSnapshot | undefined, fallbackStatus?: string) => void;
  clearCurrentChapter: () => void;
  deleteRenameTarget: () => Promise<void>;
  openChapter: (chapterId: string) => Promise<void>;
  refreshLibrary: () => Promise<void>;
  removePage: (pageId: string) => Promise<void>;
  renameBusy: boolean;
  renameChapter: (chapterId: string) => void;
  renameTarget: RenameTarget | null;
  renameWork: (workId: string) => void;
  reorderChapterInLibrary: (workId: string, sourceChapterId: string, targetChapterId: string) => void;
  reorderPageInChapter: (sourcePageId: string, targetPageId: string) => void;
  setRenameTarget: Dispatch<SetStateAction<RenameTarget | null>>;
  submitRename: (title: string) => Promise<void>;
} {
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const refreshLibrary = useCallback(async () => {
    try {
      const next = await window.mangaApi.getLibrary();
      setLibrary(next);
    } catch (error) {
      console.error(error);
      pushStatus(formatErrorMessage(error, "보관함 목록을 불러오지 못했습니다."));
    }
  }, [pushStatus, setLibrary]);

  const clearCurrentChapter = useCallback(() => {
    setCurrentChapter(null);
    currentChapterRef.current = null;
    setSelectedPageId(null);
    setSelectedBlockId(null);
    clearDirtyTracking();
  }, [clearDirtyTracking, currentChapterRef, setCurrentChapter, setSelectedBlockId, setSelectedPageId]);

  const openChapter = useCallback(
    async (chapterId: string) => {
      try {
        if (dirty) {
          await saveNow();
        }
        const chapter = await window.mangaApi.openChapter(chapterId);
        clearDirtyTracking();
        currentChapterRef.current = chapter;
        setCurrentChapter(chapter);
        setSelectedPageId(chapter.pages[0]?.id ?? null);
        setSelectedBlockId(null);
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, "화를 열지 못했습니다."));
      }
    },
    [clearDirtyTracking, currentChapterRef, dirty, pushStatus, saveNow, setCurrentChapter, setSelectedBlockId, setSelectedPageId]
  );

  const applyChapter = useCallback(
    (chapter: ChapterSnapshot | undefined, fallbackStatus?: string) => {
      if (!chapter) {
        return;
      }
      clearDirtyTracking();
      currentChapterRef.current = chapter;
      setCurrentChapter(chapter);
      setSelectedPageId((current) => (chapter.pages.some((page) => page.id === current) ? current : chapter.pages[0]?.id ?? null));
      setSelectedBlockId(null);
      if (fallbackStatus) {
        pushStatus(fallbackStatus);
      }
    },
    [clearDirtyTracking, currentChapterRef, pushStatus, setCurrentChapter, setSelectedBlockId, setSelectedPageId]
  );

  const removePage = useCallback(
    async (pageId: string) => {
      if (!currentChapter) {
        return;
      }
      const page = currentChapter.pages.find((candidate) => candidate.id === pageId);
      if (!page) {
        return;
      }
      const confirmed = await askConfirm(
        "페이지 삭제",
        "정말 삭제하시겠습니까?",
        "이 페이지와 해당 번역 결과가 보관함에서 삭제됩니다."
      );
      if (!confirmed) {
        return;
      }

      try {
        const previousOrder = currentChapter.pages.map((candidate) => candidate.id);
        const nextChapter = await window.mangaApi.deletePage(currentChapter.id, pageId);
        applyChapter(nextChapter);
        const currentIndex = previousOrder.indexOf(pageId);
        const nextId = previousOrder[currentIndex + 1] ?? previousOrder[currentIndex - 1] ?? null;
        setSelectedPageId(nextId && nextChapter.pages.some((candidate) => candidate.id === nextId) ? nextId : nextChapter.pages[0]?.id ?? null);
        pushStatus(`${page.name} 페이지를 삭제했습니다.`);
        await refreshLibrary();
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, "페이지를 삭제하지 못했습니다."));
      }
    },
    [applyChapter, askConfirm, currentChapter, pushStatus, refreshLibrary, setSelectedPageId]
  );

  const renameWork = useCallback(
    (workId: string) => {
      const work = library.works.find((candidate) => candidate.id === workId);
      if (!work) {
        return;
      }
      setRenameTarget({ kind: "work", id: workId, title: work.title });
    },
    [library.works]
  );

  const renameChapter = useCallback(
    (chapterId: string) => {
      const chapter =
        library.works.flatMap((work) => work.chapters).find((candidate) => candidate.id === chapterId) ??
        (currentChapter ? { id: currentChapter.id, title: currentChapter.title } : null);
      if (!chapter) {
        return;
      }
      setRenameTarget({ kind: "chapter", id: chapterId, title: chapter.title });
    },
    [currentChapter, library.works]
  );

  const submitRename = useCallback(
    async (title: string) => {
      if (!renameTarget) {
        return;
      }

      setRenameBusy(true);
      try {
        if (renameTarget.kind === "work") {
          setLibrary(await window.mangaApi.renameWork(renameTarget.id, title));
        } else {
          if (currentChapter?.id === renameTarget.id && dirty) {
            await saveNow();
          }
          setLibrary(await window.mangaApi.renameChapter(renameTarget.id, title));
          if (currentChapter?.id === renameTarget.id) {
            applyChapter(await window.mangaApi.openChapter(renameTarget.id));
          }
        }
        setRenameTarget(null);
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, "이름을 저장하지 못했습니다."));
      } finally {
        setRenameBusy(false);
      }
    },
    [applyChapter, currentChapter, dirty, pushStatus, renameTarget, saveNow, setLibrary]
  );

  const deleteRenameTarget = useCallback(async () => {
    if (!renameTarget) {
      return;
    }

    const isCurrentChapter = currentChapter?.id === renameTarget.id;
    const isCurrentWork = renameTarget.kind === "work" && currentChapter?.workId === renameTarget.id;
    const confirmed = await askConfirm(
      renameTarget.kind === "work" ? "작품 삭제" : "화 삭제",
      "정말 삭제하시겠습니까?",
      renameTarget.kind === "work"
        ? `"${renameTarget.title}" 작품과 포함된 모든 화, 페이지, 번역 결과가 보관함에서 삭제됩니다.`
        : `"${renameTarget.title}" 화와 포함된 모든 페이지, 번역 결과가 보관함에서 삭제됩니다.`
    );
    if (!confirmed) {
      return;
    }

    setRenameBusy(true);
    try {
      if ((isCurrentChapter || isCurrentWork) && dirty) {
        await saveNow();
      }

      if (renameTarget.kind === "work") {
        setLibrary(await window.mangaApi.deleteWork(renameTarget.id));
        if (isCurrentWork) {
          clearCurrentChapter();
        }
        pushStatus(`${renameTarget.title} 작품을 삭제했습니다.`);
      } else {
        setLibrary(await window.mangaApi.deleteChapter(renameTarget.id));
        if (isCurrentChapter) {
          clearCurrentChapter();
        }
        pushStatus(`${renameTarget.title} 화를 삭제했습니다.`);
      }

      setRenameTarget(null);
    } catch (error) {
      console.error(error);
      pushStatus(renameTarget.kind === "work" ? "작품을 삭제하지 못했습니다." : "화를 삭제하지 못했습니다.");
    } finally {
      setRenameBusy(false);
    }
  }, [askConfirm, clearCurrentChapter, currentChapter?.id, currentChapter?.workId, dirty, pushStatus, renameTarget, saveNow, setLibrary]);

  const reorderChapterInLibrary = useCallback(
    (workId: string, sourceChapterId: string, targetChapterId: string) => {
      const work = library.works.find((candidate) => candidate.id === workId);
      if (!work) {
        return;
      }
      const previousOrder = work.chapterOrder;
      const nextOrder = reorderByTarget(work.chapterOrder, sourceChapterId, targetChapterId);
      setLibrary((current) => ({
        ...current,
        works: current.works.map((candidate) =>
          candidate.id === workId
            ? {
                ...candidate,
                chapterOrder: nextOrder,
                chapters: reorderRecordsByIdOrder(candidate.chapters, nextOrder)
              }
            : candidate
        )
      }));
      void window.mangaApi
        .reorderChapters(workId, nextOrder)
        .then(setLibrary)
        .catch((error) => {
          console.error(error);
          setLibrary((current) => ({
            ...current,
            works: current.works.map((candidate) =>
              candidate.id === workId && isSameStringOrder(candidate.chapterOrder, nextOrder)
                ? {
                    ...candidate,
                    chapterOrder: previousOrder,
                    chapters: reorderRecordsByIdOrder(candidate.chapters, previousOrder)
                  }
                : candidate
            )
          }));
          const message = formatErrorMessage(error, "화 순서를 저장하지 못했습니다.");
          pushStatus(`${message} 이전 순서로 되돌렸습니다.`);
        });
    },
    [library.works, pushStatus, setLibrary]
  );

  const reorderPageInChapter = useCallback(
    (sourcePageId: string, targetPageId: string) => {
      if (!currentChapter) {
        return;
      }
      const previousOrder = currentChapter.pageOrder;
      const nextOrder = reorderByTarget(currentChapter.pageOrder, sourcePageId, targetPageId);
      setCurrentChapter((chapter) => {
        if (!chapter || chapter.id !== currentChapter.id) {
          return chapter;
        }
        const nextChapter = {
          ...chapter,
          pageOrder: nextOrder,
          pages: reorderRecordsByIdOrder(chapter.pages, nextOrder)
        };
        currentChapterRef.current = nextChapter;
        return nextChapter;
      });
      void window.mangaApi
        .reorderPages(currentChapter.id, nextOrder)
        .then((chapter) => {
          applyChapter(chapter);
          void refreshLibrary().catch((error) => {
            console.error(error);
            pushStatus(formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."));
          });
        })
        .catch((error) => {
          console.error(error);
          setCurrentChapter((chapter) => {
            if (!chapter || chapter.id !== currentChapter.id || !isSameStringOrder(chapter.pageOrder, nextOrder)) {
              return chapter;
            }
            const rolledBackChapter = {
              ...chapter,
              pageOrder: previousOrder,
              pages: reorderRecordsByIdOrder(chapter.pages, previousOrder)
            };
            currentChapterRef.current = rolledBackChapter;
            return rolledBackChapter;
          });
          const message = formatErrorMessage(error, "페이지 순서를 저장하지 못했습니다.");
          pushStatus(`${message} 이전 순서로 되돌렸습니다.`);
        });
    },
    [applyChapter, currentChapter, currentChapterRef, pushStatus, refreshLibrary, setCurrentChapter]
  );

  return {
    applyChapter,
    clearCurrentChapter,
    deleteRenameTarget,
    openChapter,
    refreshLibrary,
    removePage,
    renameBusy,
    renameChapter,
    renameTarget,
    renameWork,
    reorderChapterInLibrary,
    reorderPageInChapter,
    setRenameTarget,
    submitRename
  };
}
