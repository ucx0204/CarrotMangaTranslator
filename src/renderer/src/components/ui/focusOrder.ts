const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keyboard-reachable descendants of `container`, in DOM (Tab) order. */
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) => element.offsetParent !== null && !element.closest("[inert]"),
  );
}

/**
 * The control the Tab key would reach from `from` in `direction`, staying in
 * the enclosing dialog when there is one. `from` itself may already be
 * disabled: its DOM position is still the reference point.
 */
export function findAdjacentFocusable(
  from: HTMLElement,
  direction: -1 | 1,
): HTMLElement | null {
  const scope =
    from.closest<HTMLElement>('[role="dialog"]') ?? from.ownerDocument.body;
  const candidates = getFocusable(scope).filter((element) => element !== from);
  const follows = (element: HTMLElement): boolean =>
    Boolean(
      from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  return direction > 0
    ? (candidates.find(follows) ?? null)
    : (candidates.filter((element) => !follows(element)).at(-1) ?? null);
}
