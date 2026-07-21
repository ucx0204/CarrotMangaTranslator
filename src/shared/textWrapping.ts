import type { RenderTextDirection, TextWordBreak } from "./textTypes";

export type { TextWordBreak } from "./textTypes";

export const TEXT_WORD_BREAK_VALUES = [
  "normal",
  "break-all",
  "keep-all",
  "break-word",
] as const satisfies readonly TextWordBreak[];

/** Matches the text overflow behavior used before wrapping became configurable. */
export const DEFAULT_TEXT_WORD_BREAK: TextWordBreak = "break-word";

const TEXT_WORD_BREAK_VALUE_SET: ReadonlySet<string> = new Set(
  TEXT_WORD_BREAK_VALUES,
);

export function resolveTextWordBreak(
  value: unknown,
  fallback: TextWordBreak = DEFAULT_TEXT_WORD_BREAK,
): TextWordBreak {
  if (typeof value === "string" && TEXT_WORD_BREAK_VALUE_SET.has(value)) {
    return value as TextWordBreak;
  }
  return TEXT_WORD_BREAK_VALUE_SET.has(fallback)
    ? fallback
    : DEFAULT_TEXT_WORD_BREAK;
}

/**
 * Blocks saved before v1.6.5 have no wordBreak field. Horizontal text used
 * eager character wrapping, while vertical text used break-word/anywhere CSS.
 */
export function resolveBlockTextWordBreak(
  value: unknown,
  renderDirection: RenderTextDirection,
): TextWordBreak {
  if (typeof value === "string" && TEXT_WORD_BREAK_VALUE_SET.has(value)) {
    return value as TextWordBreak;
  }
  return renderDirection === "vertical" ? "break-word" : "break-all";
}
