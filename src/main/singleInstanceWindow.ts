export type FocusableMainWindow = {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  isVisible: () => boolean;
  show: () => void;
  focus: () => void;
};

export function focusExistingMainWindow(
  window: FocusableMainWindow | null,
): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
  return true;
}
