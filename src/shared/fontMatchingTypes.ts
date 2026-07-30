import type { UiLocale } from "./uiLocales";

export type AutomaticFontSemanticSlot =
  | "body"
  | "strong-impact"
  | "sharp-motion"
  | "soft-emotion"
  | "comic-reaction"
  | "ambient-eerie";

export type AutomaticFontUnicodeRange = readonly [
  startCodePoint: number,
  endCodePoint: number,
];

/**
 * Immutable, job-scoped description of one usable font face.
 *
 * `fontId` is either a built-in catalog id or a CustomFont UUID stored in
 * TranslationBlock.fontFamily. File paths and raw bytes never cross the
 * pipeline boundary.
 */
export type AutomaticFontCandidate = Readonly<{
  source: "built-in" | "custom";
  fontId: string;
  label: string;
  supportedLocales: readonly UiLocale[];
  unicodeRanges: readonly AutomaticFontUnicodeRange[];
  weight: number;
  width: number;
  italic: boolean;
  serif?: boolean;
  favorite: boolean;
  defaultFont: boolean;
  preferenceRank: number;
}>;
