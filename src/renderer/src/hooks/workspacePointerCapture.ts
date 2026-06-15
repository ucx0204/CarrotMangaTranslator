export function capturePointerSafely(
  element: HTMLElement | null,
  pointerId: number,
): void {
  try {
    element?.setPointerCapture(pointerId);
  } catch (_error) {
    // Pointer capture can fail if the pointer was already released by the browser.
  }
}

export function releasePointerCaptureSafely(
  element: HTMLElement | null,
  pointerId: number,
): void {
  try {
    if (element?.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch (_error) {
    // Ignore stale pointer ids. The interaction state is reset by the caller.
  }
}
