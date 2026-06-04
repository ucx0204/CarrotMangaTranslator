import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type React from "react";
import type { ChapterSnapshot } from "../../../shared/types";
import { isEditableTarget } from "../lib/appHelpers";
import { resolveAdjacentPageId, resolveKeyboardPageNavigation, resolveWheelPageNavigation } from "../lib/pageNavigation";

type UsePageNavigationHandlersOptions = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedBlockIdRef: MutableRefObject<string | null>;
  workspacePanelRef: RefObject<HTMLElement | null>;
  modalOpen: boolean;
  inpaintingMode: boolean;
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  undoRetouch: () => Promise<void>;
  redoRetouch: () => Promise<void>;
};

export function usePageNavigationHandlers({
  currentChapterRef,
  selectedPageIdRef,
  selectedBlockIdRef,
  workspacePanelRef,
  modalOpen,
  inpaintingMode,
  setSelectedPageId,
  setSelectedBlockId,
  undoRetouch,
  redoRetouch
}: UsePageNavigationHandlersOptions): {
  selectPageForReading: (pageId: string | null) => void;
  onWorkspaceWheel: (event: React.WheelEvent<HTMLElement>) => void;
} {
  const lastWheelNavigationAtRef = useRef(0);

  const selectPageForReading = useCallback((pageId: string | null) => {
    if (!pageId) {
      return;
    }
    selectedPageIdRef.current = pageId;
    selectedBlockIdRef.current = null;
    setSelectedPageId(pageId);
    setSelectedBlockId(null);
  }, [selectedBlockIdRef, selectedPageIdRef, setSelectedBlockId, setSelectedPageId]);

  const selectAdjacentPageForReading = useCallback(
    (direction: "previous" | "next") => {
      const chapter = currentChapterRef.current;
      const pageIds = chapter?.pages.map((page) => page.id) ?? [];
      const nextPageId = resolveAdjacentPageId(pageIds, selectedPageIdRef.current, direction);
      if (!nextPageId) {
        return false;
      }

      selectPageForReading(nextPageId);
      return true;
    },
    [currentChapterRef, selectPageForReading, selectedPageIdRef]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const pageIds = currentChapterRef.current?.pages.map((page) => page.id) ?? [];
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      const editableTarget = isEditableTarget(event.target);
      if (inpaintingMode && !modalOpen && !editableTarget && (event.ctrlKey || event.metaKey)) {
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          void undoRetouch();
          return;
        }
        if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          void redoRetouch();
          return;
        }
      }
      const navigation = resolveKeyboardPageNavigation({
        key: event.key,
        hasPages: pageIds.length > 0,
        modalOpen,
        editableTarget,
        centerPanelFocused: Boolean(workspacePanelRef.current && activeElement && workspacePanelRef.current.contains(activeElement))
      });

      if (!navigation) {
        return;
      }

      if (!selectAdjacentPageForReading(navigation.direction)) {
        return;
      }

      if (navigation.preventDefault) {
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [currentChapterRef, inpaintingMode, modalOpen, redoRetouch, selectAdjacentPageForReading, undoRetouch, workspacePanelRef]);

  const onWorkspaceWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>) => {
      const pageIds = currentChapterRef.current?.pages.map((page) => page.id) ?? [];
      const direction = resolveWheelPageNavigation({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        hasPages: pageIds.length > 0,
        modalOpen,
        editableTarget: isEditableTarget(event.target)
      });

      if (!direction) {
        return;
      }

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastWheelNavigationAtRef.current < 320) {
        event.preventDefault();
        return;
      }

      if (!selectAdjacentPageForReading(direction)) {
        return;
      }

      lastWheelNavigationAtRef.current = now;
      workspacePanelRef.current?.focus();
      event.preventDefault();
    },
    [currentChapterRef, modalOpen, selectAdjacentPageForReading, workspacePanelRef]
  );

  return {
    selectPageForReading,
    onWorkspaceWheel
  };
}
