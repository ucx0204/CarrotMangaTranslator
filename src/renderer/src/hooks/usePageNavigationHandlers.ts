import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { isEditableTarget } from "../lib/appHelpers";
import {
  resolveAdjacentPageId,
  resolveKeyboardPageNavigation,
  resolveWheelPageNavigation,
} from "../lib/pageNavigation";
import type { ChapterSnapshot } from "./hookLibraryTypes";

type UsePageNavigationHandlersOptions = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedBlockIdRef: MutableRefObject<string | null>;
  workspacePanelRef: RefObject<HTMLElement | null>;
  modalOpen: boolean;
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
};

type SelectPageForReading = (pageId: string | null) => void;
type SelectAdjacentPageForReading = (direction: "previous" | "next") => boolean;

export function usePageNavigationHandlers(
  options: UsePageNavigationHandlersOptions,
): {
  selectPageForReading: SelectPageForReading;
} {
  const lastWheelNavigationAtRef = useRef(0);
  const selectPageForReading = useSelectPageForReading(options);
  const selectAdjacentPageForReading = useSelectAdjacentPageForReading(
    options,
    selectPageForReading,
  );
  useKeyboardPageNavigationEffect(options, selectAdjacentPageForReading);
  const handleWorkspaceWheel = useWorkspaceWheelHandler(
    options,
    selectAdjacentPageForReading,
    lastWheelNavigationAtRef,
  );
  useWorkspaceWheelEffect(options.workspacePanelRef, handleWorkspaceWheel);

  return {
    selectPageForReading,
  };
}

function useSelectPageForReading({
  selectedBlockIdRef,
  selectedPageIdRef,
  setSelectedBlockId,
  setSelectedPageId,
}: UsePageNavigationHandlersOptions): SelectPageForReading {
  return useCallback(
    (pageId) => {
      if (!pageId) {
        return;
      }
      selectedPageIdRef.current = pageId;
      selectedBlockIdRef.current = null;
      setSelectedPageId(pageId);
      setSelectedBlockId(null);
    },
    [
      selectedBlockIdRef,
      selectedPageIdRef,
      setSelectedBlockId,
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

function useKeyboardPageNavigationEffect(
  options: UsePageNavigationHandlersOptions,
  selectAdjacentPageForReading: SelectAdjacentPageForReading,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const navigation = resolveKeyboardNavigationForEvent(event, options);
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
  }, [options, selectAdjacentPageForReading]);
}

function useWorkspaceWheelHandler(
  {
    currentChapterRef,
    modalOpen,
    workspacePanelRef,
  }: UsePageNavigationHandlersOptions,
  selectAdjacentPageForReading: SelectAdjacentPageForReading,
  lastWheelNavigationAtRef: MutableRefObject<number>,
): (event: WheelEvent) => void {
  return useCallback(
    (event) => {
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

function resolveKeyboardNavigationForEvent(
  event: KeyboardEvent,
  {
    currentChapterRef,
    modalOpen,
    workspacePanelRef,
  }: UsePageNavigationHandlersOptions,
): ReturnType<typeof resolveKeyboardPageNavigation> {
  const activeElement =
    typeof document !== "undefined" ? document.activeElement : null;
  const pageIds = currentChapterRef.current?.pages.map((page) => page.id) ?? [];
  return resolveKeyboardPageNavigation({
    key: event.key,
    hasPages: pageIds.length > 0,
    modalOpen,
    editableTarget: isEditableTarget(event.target),
    centerPanelFocused: Boolean(
      workspacePanelRef.current &&
      activeElement &&
      workspacePanelRef.current.contains(activeElement),
    ),
  });
}

function resolveWheelThrottle(
  lastWheelNavigationAtRef: MutableRefObject<number>,
): boolean {
  return nowMs() - lastWheelNavigationAtRef.current < 320;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
