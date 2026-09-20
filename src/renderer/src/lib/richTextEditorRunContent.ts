import type { TranslationBlock } from "../../../shared/textTypes";
import type { TextStyleRun } from "../../../shared/richTextMarkup";
import {
  resolveEditorRunVisualStyle,
  resolveRunTextDecorationStyle,
  resolveRunWidthGeometry,
} from "./textRunVisualStyles";
import { segmentGraphemes } from "./overlayTextSegmentation";

export function appendRichTextRunContent(
  span: HTMLSpanElement,
  run: TextStyleRun,
  block: TranslationBlock | undefined,
  text: string,
): void {
  if ((run.widthScale ?? 1) !== 1) {
    appendWidthScaledText(span, run, block, text);
    return;
  }
  if (block) {
    const visualStyle = resolveEditorRunVisualStyle(
      block,
      run,
      16,
      block.renderDirection,
    );
    const decorationStyle = resolveRunTextDecorationStyle(block, run);
    if (decorationStyle) {
      Object.assign(span.style, decorationStyle);
      const glyph = span.ownerDocument.createElement("span");
      glyph.dataset.richTextGlyph = "";
      Object.assign(glyph.style, visualStyle);
      glyph.append(span.ownerDocument.createTextNode(text));
      span.append(glyph);
      return;
    }
    Object.assign(span.style, visualStyle);
  }
  span.append(span.ownerDocument.createTextNode(text));
  return;
}

function appendWidthScaledText(
  span: HTMLSpanElement,
  run: TextStyleRun,
  block: TranslationBlock | undefined,
  text: string,
): void {
  const visualStyle = block
    ? resolveEditorRunVisualStyle(block, run, 16, block.renderDirection)
    : {};
  const decoration = block ? resolveRunTextDecorationStyle(block, run) : null;
  Object.assign(span.style, decoration);
  for (const grapheme of segmentGraphemes(text)) {
    if (grapheme === "\n") {
      // Keep newlines in the text-node offsets used by caret/IME restoration.
      span.append(span.ownerDocument.createTextNode("\n"));
      continue;
    }
    const geometry = resolveRunWidthGeometry(grapheme, run.widthScale ?? 1, {
      size: Number.parseFloat(span.style.fontSize),
      family: span.style.fontFamily,
      weight: Number(span.style.fontWeight),
      italic: span.style.fontStyle === "italic",
    });
    const container = span.ownerDocument.createElement("span");
    Object.assign(container.style, geometry.container);
    const glyph = span.ownerDocument.createElement("span");
    glyph.dataset.richTextGlyph = "";
    Object.assign(glyph.style, visualStyle, geometry.glyph);
    glyph.textContent = grapheme;
    container.append(glyph);
    span.append(container);
  }
}
