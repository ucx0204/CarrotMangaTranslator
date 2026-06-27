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
  verticalScroll?: VerticalScrollState | null;
};

type VerticalScrollState = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

const MIN_WHEEL_PAGE_DELTA = 18;

export function resolveAdjacentPageId(
  pageIds: string[],
  selectedPageId: string | null,
  direction: PageNavigationDirection,
): string | null {
  if (!pageIds.length) {
    return null;
  }

  const currentIndex = Math.max(0, pageIds.indexOf(selectedPageId ?? ""));
  const targetIndex =
    direction === "previous" ? currentIndex - 1 : currentIndex + 1;

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
  centerPanelFocused,
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
      return centerPanelFocused
        ? { direction: "previous", preventDefault: true }
        : null;
    case "ArrowDown":
      return centerPanelFocused
        ? { direction: "next", preventDefault: true }
        : null;
    default:
      return null;
  }
}

export function resolveWheelPageNavigation({
  deltaX,
  deltaY,
  hasPages,
  modalOpen,
  editableTarget,
  verticalScroll,
}: WheelPageNavigationOptions): PageNavigationDirection | null {
  if (!hasPages || modalOpen || editableTarget) {
    return null;
  }

  if (
    Math.abs(deltaY) < MIN_WHEEL_PAGE_DELTA ||
    Math.abs(deltaY) < Math.abs(deltaX)
  ) {
    return null;
  }

  const direction = deltaY > 0 ? "next" : "previous";
  return canScrollFurther(verticalScroll, direction) ? null : direction;
}

function canScrollFurther(
  state: VerticalScrollState | null | undefined,
  direction: PageNavigationDirection,
): boolean {
  if (!state) {
    return false;
  }
  const maxScrollTop = Math.max(0, state.scrollHeight - state.clientHeight);
  if (maxScrollTop <= 1) {
    return false;
  }
  if (direction === "next") {
    return state.scrollTop < maxScrollTop - 1;
  }
  return state.scrollTop > 1;
}
