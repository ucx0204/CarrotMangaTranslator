import type { TextStylePatch } from "../../../shared/richTextMarkup";

export type RichTranslationEditorMode = "visual" | "code";

export type RichTranslationSelectionValues = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  emphasisMark: boolean;
  sizePx: number;
  sizeMixed: boolean;
  fontFamily: string | undefined;
  fontMixed: boolean;
  opacityPercent: number;
  opacityMixed: boolean;
  widthPercent: number;
  color: string;
  backgroundEnabled: boolean;
  backgroundColor: string;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidthPx: number;
  outerOutlineEnabled: boolean;
  outerOutlineColor: string;
  outerOutlineWidthPx: number;
  glowEnabled: boolean;
  glowColor: string;
  glowBlurPx: number;
  glowOpacityPercent: number;
};

export type RichTranslationInlineStyleAction = (patch: TextStylePatch) => void;
