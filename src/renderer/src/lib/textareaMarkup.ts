export type InlineMarkupResult = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

export type InlineStyleTagName =
  | "size"
  | "font"
  | "opacity"
  | "width"
  | "color"
  | "background"
  | "outline-color"
  | "outline-width"
  | "outer-outline-color"
  | "outer-outline-width"
  | "glow-color"
  | "glow-blur"
  | "glow-opacity";

export type InlineBooleanStyleTagName = "underline" | "strike" | "emphasis";

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

export function applyInlineStyleTag(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  name: InlineStyleTagName,
  tagValue: string | number,
): InlineMarkupResult {
  const start = clampIndex(selectionStart, value.length);
  const end = clampIndex(selectionEnd, value.length);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const opening = `[${name}=${tagValue}]`;
  const closing = `[/${name}]`;
  const selected = value.slice(from, to);
  return {
    value: `${value.slice(0, from)}${opening}${selected}${closing}${value.slice(to)}`,
    selectionStart: from + opening.length,
    selectionEnd: from + opening.length + selected.length,
  };
}

export function applyInlineBooleanStyleTag(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  name: InlineBooleanStyleTagName,
): InlineMarkupResult {
  const start = clampIndex(selectionStart, value.length);
  const end = clampIndex(selectionEnd, value.length);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const opening = `[${name}]`;
  const closing = `[/${name}]`;
  const selected = value.slice(from, to);
  return {
    value: `${value.slice(0, from)}${opening}${selected}${closing}${value.slice(to)}`,
    selectionStart: from + opening.length,
    selectionEnd: from + opening.length + selected.length,
  };
}

/** Remove the nearest matching value tag that encloses the code selection. */
export function removeInlineStyleTag(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  name: InlineStyleTagName,
): InlineMarkupResult {
  return removeEnclosingTag(
    value,
    selectionStart,
    selectionEnd,
    new RegExp(`\\[(/?)${escapeRegExp(name)}(?:=[^\\]\\r\\n]*)?\\]`, "g"),
  );
}

/** Remove the nearest matching boolean tag that encloses the code selection. */
export function removeInlineBooleanStyleTag(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  name: InlineBooleanStyleTagName,
): InlineMarkupResult {
  return removeEnclosingTag(
    value,
    selectionStart,
    selectionEnd,
    new RegExp(`\\[(/?)${escapeRegExp(name)}\\]`, "g"),
  );
}

function removeEnclosingTag(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  tagPattern: RegExp,
): InlineMarkupResult {
  const start = clampIndex(selectionStart, value.length);
  const end = clampIndex(selectionEnd, value.length);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const stack: Array<{ start: number; end: number }> = [];
  const candidates: Array<{
    opening: { start: number; end: number };
    closing: { start: number; end: number };
  }> = [];
  for (const match of value.matchAll(tagPattern)) {
    const token = match[0];
    // String.matchAll always supplies an index for a global RegExp match.
    const tokenStart = match.index as number;
    const tokenRange = { start: tokenStart, end: tokenStart + token.length };
    if (match[1] === "/") {
      const opening = stack.pop();
      if (opening) candidates.push({ opening, closing: tokenRange });
    } else {
      stack.push(tokenRange);
    }
  }
  const enclosing = candidates
    .filter(
      ({ opening, closing }) => opening.end <= from && closing.start >= to,
    )
    .sort(
      (left, right) =>
        left.closing.end -
        left.opening.start -
        (right.closing.end - right.opening.start),
    )[0];
  if (!enclosing) {
    return { value, selectionStart: from, selectionEnd: to };
  }
  const openingLength = enclosing.opening.end - enclosing.opening.start;
  return {
    value:
      value.slice(0, enclosing.opening.start) +
      value.slice(enclosing.opening.end, enclosing.closing.start) +
      value.slice(enclosing.closing.end),
    selectionStart: from - openingLength,
    selectionEnd: to - openingLength,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) {
    return length;
  }
  return Math.min(length, Math.max(0, Math.trunc(index)));
}
