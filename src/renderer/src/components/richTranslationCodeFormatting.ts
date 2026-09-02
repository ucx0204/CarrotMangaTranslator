import type { TextStylePatch } from "../../../shared/richTextMarkup";
import {
  applyInlineBooleanStyleTag,
  applyInlineMarkup,
  applyInlineStyleTag,
  removeInlineBooleanStyleTag,
  removeInlineStyleTag,
  type InlineMarkupResult,
} from "../lib/textareaMarkup";
import type { RichTextEditorSelection } from "../lib/richTextEditorDom";

type BooleanStyleTag = "underline" | "strike" | "emphasis";
type ValueStyleTag =
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

export function applyRichTranslationCodeStyle(
  value: string,
  selection: RichTextEditorSelection,
  patch: TextStylePatch,
): InlineMarkupResult | null {
  return (
    applyEmphasisPatch(value, selection, patch) ??
    applyTypographyPatch(value, selection, patch) ??
    applyAppearancePatch(value, selection, patch) ??
    applyOutlinePatch(value, selection, patch) ??
    applyGlowPatch(value, selection, patch)
  );
}

function applyEmphasisPatch(
  value: string,
  selection: RichTextEditorSelection,
  patch: TextStylePatch,
): InlineMarkupResult | null {
  if (patch.bold !== undefined) {
    return applyInlineMarkup(value, selection.start, selection.end, "**");
  }
  if (patch.italic !== undefined) {
    return applyInlineMarkup(value, selection.start, selection.end, "*");
  }
  if (patch.underline !== undefined) {
    return applyBooleanStyle(value, selection, "underline", patch.underline);
  }
  if (patch.strikethrough !== undefined) {
    return applyBooleanStyle(value, selection, "strike", patch.strikethrough);
  }
  if (patch.emphasisMark !== undefined) {
    return applyBooleanStyle(value, selection, "emphasis", patch.emphasisMark);
  }
  return null;
}

function applyTypographyPatch(
  value: string,
  selection: RichTextEditorSelection,
  patch: TextStylePatch,
): InlineMarkupResult | null {
  if (patch.sizePx !== undefined) {
    return applyValueStyle(value, selection, "size", patch.sizePx);
  }
  if (patch.fontFamily !== undefined) {
    return applyValueStyle(value, selection, "font", patch.fontFamily);
  }
  if (patch.opacity !== undefined) {
    return applyValueStyle(
      value,
      selection,
      "opacity",
      patch.opacity === null ? null : formatRichTextNumber(patch.opacity * 100),
    );
  }
  if (patch.widthScale !== undefined) {
    return applyValueStyle(
      value,
      selection,
      "width",
      patch.widthScale === null ? null : formatRichTextNumber(patch.widthScale),
    );
  }
  return null;
}

function applyAppearancePatch(
  value: string,
  selection: RichTextEditorSelection,
  patch: TextStylePatch,
): InlineMarkupResult | null {
  if (patch.color !== undefined) {
    return applyValueStyle(value, selection, "color", patch.color);
  }
  if (patch.backgroundColor !== undefined) {
    return applyValueStyle(
      value,
      selection,
      "background",
      patch.backgroundColor,
    );
  }
  return null;
}

function applyOutlinePatch(
  value: string,
  selection: RichTextEditorSelection,
  patch: TextStylePatch,
): InlineMarkupResult | null {
  if (patch.outlineColor !== undefined) {
    return applyValueStyle(
      value,
      selection,
      "outline-color",
      patch.outlineColor,
    );
  }
  if (patch.outlineWidthPx !== undefined) {
    return applyNumericStyle(
      value,
      selection,
      "outline-width",
      patch.outlineWidthPx,
    );
  }
  if (patch.outerOutlineColor !== undefined) {
    return applyValueStyle(
      value,
      selection,
      "outer-outline-color",
      patch.outerOutlineColor,
    );
  }
  if (patch.outerOutlineWidthPx !== undefined) {
    return applyNumericStyle(
      value,
      selection,
      "outer-outline-width",
      patch.outerOutlineWidthPx,
    );
  }
  return null;
}

function applyGlowPatch(
  value: string,
  selection: RichTextEditorSelection,
  patch: TextStylePatch,
): InlineMarkupResult | null {
  if (patch.glowColor !== undefined) {
    return applyValueStyle(value, selection, "glow-color", patch.glowColor);
  }
  if (patch.glowBlurPx !== undefined) {
    return applyNumericStyle(value, selection, "glow-blur", patch.glowBlurPx);
  }
  if (patch.glowOpacity !== undefined) {
    return applyNumericStyle(
      value,
      selection,
      "glow-opacity",
      patch.glowOpacity,
    );
  }
  return null;
}

function applyBooleanStyle(
  value: string,
  selection: RichTextEditorSelection,
  tag: BooleanStyleTag,
  enabled: boolean | null,
): InlineMarkupResult {
  return enabled
    ? applyInlineBooleanStyleTag(value, selection.start, selection.end, tag)
    : removeInlineBooleanStyleTag(value, selection.start, selection.end, tag);
}

function applyNumericStyle(
  value: string,
  selection: RichTextEditorSelection,
  tag: ValueStyleTag,
  styleValue: number | null,
): InlineMarkupResult {
  return applyValueStyle(
    value,
    selection,
    tag,
    styleValue === null ? null : formatRichTextNumber(styleValue),
  );
}

function applyValueStyle(
  value: string,
  selection: RichTextEditorSelection,
  tag: ValueStyleTag,
  styleValue: string | number | null,
): InlineMarkupResult {
  return styleValue === null
    ? removeInlineStyleTag(value, selection.start, selection.end, tag)
    : applyInlineStyleTag(
        value,
        selection.start,
        selection.end,
        tag,
        styleValue,
      );
}

function formatRichTextNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}
