export function capturePointerSafely(
  element: HTMLElement | null,
  pointerId: number,
): void {
  try {
    element?.setPointerCapture(pointerId);
  } catch (_error) {
    // error-policy-allow: the browser may already have released this pointer id.
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
    // error-policy-allow: stale pointer ids are followed by caller-owned state reset.
  }
}
