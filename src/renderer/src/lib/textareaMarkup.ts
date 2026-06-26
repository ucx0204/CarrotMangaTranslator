export type InlineMarkupResult = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

/**
 * Wrap the current textarea selection with an inline marker (e.g. `**` or `*`).
 * When nothing is selected, the markers are inserted with the caret placed
 * between them so the user can type the emphasized text.
 */
export function applyInlineMarkup(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  marker: string,
): InlineMarkupResult {
  const start = clampIndex(selectionStart, value.length);
  const end = clampIndex(selectionEnd, value.length);
  const from = Math.min(start, end);
  const to = Math.max(start, end);

  const before = value.slice(0, from);
  const selected = value.slice(from, to);
  const after = value.slice(to);

  return {
    value: `${before}${marker}${selected}${marker}${after}`,
    selectionStart: from + marker.length,
    selectionEnd: from + marker.length + selected.length,
  };
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) {
    return length;
  }
  return Math.min(length, Math.max(0, Math.trunc(index)));
}
