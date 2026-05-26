export type PageNavigationDirection = "previous" | "next";

type KeyboardPageNavigationOptions = {
  key: string;
  hasPages: boolean;
  modalOpen: boolean;
  editableTarget: boolean;
  centerPanelFocused: boolean;
};

type KeyboardPageNavigation = {
  direction: PageNavigationDirection;
  preventDefault: boolean;
};

type WheelPageNavigationOptions = {
  deltaX: number;
  deltaY: number;
  hasPages: boolean;
  modalOpen: boolean;
  editableTarget: boolean;
};

const MIN_WHEEL_PAGE_DELTA = 18;

export function resolveAdjacentPageId(
  pageIds: string[],
  selectedPageId: string | null,
  direction: PageNavigationDirection
): string | null {
  if (!pageIds.length) {
    return null;
  }

  const currentIndex = Math.max(0, pageIds.indexOf(selectedPageId ?? ""));
  const targetIndex = direction === "previous" ? currentIndex - 1 : currentIndex + 1;

  if (targetIndex < 0 || targetIndex >= pageIds.length) {
    return null;
  }

  return pageIds[targetIndex] ?? null;
}

export function resolveKeyboardPageNavigation({
  key,
  hasPages,
  modalOpen,
  editableTarget,
  centerPanelFocused
}: KeyboardPageNavigationOptions): KeyboardPageNavigation | null {
  if (!hasPages || modalOpen || editableTarget) {
    return null;
  }

  switch (key) {
    case "ArrowLeft":
      return { direction: "previous", preventDefault: false };
    case "ArrowRight":
      return { direction: "next", preventDefault: false };
    case "ArrowUp":
      return centerPanelFocused ? { direction: "previous", preventDefault: true } : null;
    case "ArrowDown":
      return centerPanelFocused ? { direction: "next", preventDefault: true } : null;
    default:
      return null;
  }
}

export function resolveWheelPageNavigation({
  deltaX,
  deltaY,
  hasPages,
  modalOpen,
  editableTarget
}: WheelPageNavigationOptions): PageNavigationDirection | null {
  if (!hasPages || modalOpen || editableTarget) {
    return null;
  }

  if (Math.abs(deltaY) < MIN_WHEEL_PAGE_DELTA || Math.abs(deltaY) < Math.abs(deltaX)) {
    return null;
  }

  return deltaY > 0 ? "next" : "previous";
}
