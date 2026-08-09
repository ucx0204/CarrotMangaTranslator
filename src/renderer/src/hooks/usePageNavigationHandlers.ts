import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { isEditableTarget } from "../lib/appHelpers";
import {
  resolveAdjacentPageId,
  resolveWheelPageNavigation,
} from "../lib/pageNavigation";
import { useEventCallback } from "./useEventCallback";

type UsePageNavigationHandlersOptions = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedBlockIdRef: MutableRefObject<string | null>;
  workspacePanelRef: RefObject<HTMLElement | null>;
  modalOpen: boolean;
  onPageChange?: () => void;
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
};

type SelectPageForReading = (pageId: string | null) => void;
type SelectAdjacentPageForReading = (direction: "previous" | "next") => boolean;

export function usePageNavigationHandlers(
  options: UsePageNavigationHandlersOptions,
): {
  selectPageForReading: SelectPageForReading;
  selectAdjacentPageForReading: SelectAdjacentPageForReading;
} {
  const lastWheelNavigationAtRef = useRef(0);
  const selectPageForReading = useSelectPageForReading(options);
  const selectAdjacentPageForReading = useSelectAdjacentPageForReading(
    options,
    selectPageForReading,
  );
  const handleWorkspaceWheel = useWorkspaceWheelHandler(
    options,
    selectAdjacentPageForReading,
    lastWheelNavigationAtRef,
  );
  useWorkspaceWheelEffect(options.workspacePanelRef, handleWorkspaceWheel);

  return {
    selectPageForReading,
    selectAdjacentPageForReading,
  };
}

function useSelectPageForReading({
  onPageChange,
  selectedBlockIdRef,
  selectedPageIdRef,
  setSelectedBlockId,
  setSelectedBlockIds,
  setSelectedPageId,
}: UsePageNavigationHandlersOptions): SelectPageForReading {
  const notifyPageChange = useEventCallback(() => {
    onPageChange?.();
  });
  return useCallback(
    (pageId) => {
      if (!pageId) {
        return;
      }
      notifyPageChange();
      selectedPageIdRef.current = pageId;
      selectedBlockIdRef.current = null;
      setSelectedPageId(pageId);
      setSelectedBlockId(null);
      setSelectedBlockIds([]);
    },
    [
      notifyPageChange,
      selectedBlockIdRef,
      selectedPageIdRef,
      setSelectedBlockId,
      setSelectedBlockIds,
      setSelectedPageId,
    ],
  );
}

function useSelectAdjacentPageForReading(
  { currentChapterRef, selectedPageIdRef }: UsePageNavigationHandlersOptions,
  selectPageForReading: SelectPageForReading,
): SelectAdjacentPageForReading {
  return useCallback(
    (direction) => {
      const pageIds =
        currentChapterRef.current?.pages.map((page) => page.id) ?? [];
      const nextPageId = resolveAdjacentPageId(
        pageIds,
        selectedPageIdRef.current,
        direction,
      );
      if (!nextPageId) {
        return false;
      }
      selectPageForReading(nextPageId);
      return true;
    },
    [currentChapterRef, selectPageForReading, selectedPageIdRef],
  );
}

function useWorkspaceWheelHandler(
  {
    currentChapterRef,
    modalOpen,
    workspacePanelRef,
  }: Pick<
    UsePageNavigationHandlersOptions,
    "currentChapterRef" | "modalOpen" | "workspacePanelRef"
  >,
  selectAdjacentPageForReading: SelectAdjacentPageForReading,
  lastWheelNavigationAtRef: MutableRefObject<number>,
): (event: WheelEvent) => void {
  return useCallback(
    (event) => {
      // User-configured wheel shortcuts are resolved in capture phase.
      if (event.defaultPrevented) {
        return;
      }
      // Ctrl+wheel is the workspace zoom gesture, never page navigation.
      if (event.ctrlKey) {
        return;
      }
      const pageIds =
        currentChapterRef.current?.pages.map((page) => page.id) ?? [];
      const direction = resolveWheelPageNavigation({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        hasPages: pageIds.length > 0,
        modalOpen,
        editableTarget: isEditableTarget(event.target),
        verticalScroll: resolveWorkspaceVerticalScrollState(
          workspacePanelRef.current,
        ),
      });
      if (!direction) {
        return;
      }
      if (resolveWheelThrottle(lastWheelNavigationAtRef)) {
        event.preventDefault();
        return;
      }
      if (!selectAdjacentPageForReading(direction)) {
        return;
      }
      lastWheelNavigationAtRef.current = nowMs();
      workspacePanelRef.current?.focus();
      event.preventDefault();
    },
    [
      currentChapterRef,
      lastWheelNavigationAtRef,
      modalOpen,
      selectAdjacentPageForReading,
      workspacePanelRef,
    ],
  );
}

function resolveWorkspaceVerticalScrollState(panel: HTMLElement | null): {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
} | null {
  if (!panel) {
    return null;
  }
  return {
    scrollTop: panel.scrollTop,
    scrollHeight: panel.scrollHeight,
    clientHeight: panel.clientHeight,
  };
}

function useWorkspaceWheelEffect(
  workspacePanelRef: RefObject<HTMLElement | null>,
  handleWorkspaceWheel: (event: WheelEvent) => void,
): void {
  useEffect(() => {
    const panel = workspacePanelRef.current;
    if (!panel) {
      return;
    }
    panel.addEventListener("wheel", handleWorkspaceWheel, { passive: false });
    return () => {
      panel.removeEventListener("wheel", handleWorkspaceWheel);
    };
  }, [handleWorkspaceWheel, workspacePanelRef]);
}

function resolveWheelThrottle(
  lastWheelNavigationAtRef: MutableRefObject<number>,
): boolean {
  return nowMs() - lastWheelNavigationAtRef.current < 320;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
