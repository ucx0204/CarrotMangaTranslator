import {
  bboxToPixels,
  clamp,
  normalizeRenderDirection,
  resolveEffectiveRenderBbox,
} from "../shared/geometry";
import type { MangaPage } from "../shared/libraryTypes";
import type { TranslationBlock } from "../shared/textTypes";

export type PageExportBlock = {
  text: string;
  rect: { left: number; top: number; width: number; height: number };
  renderDirection: "horizontal" | "vertical";
  rotationDeg: number;
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  letterSpacing: number;
  textAlign: "left" | "center" | "right";
  textColor: string;
  outlineColor: string;
  bold: boolean;
  italic: boolean;
  outlineWidthScale: number;
  autoFitText: boolean;
};

const DEFAULT_EXPORT_FONT_FAMILY =
  '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif';

const EXPORT_FONT_FAMILY_BY_ID: ReadonlyMap<string, string> = new Map([
  ["mongtori", '"MGT Mongtori", "Malgun Gothic", sans-serif'],
  ["chosun-gungseo", '"MGT Chosun Gungseo", "Malgun Gothic", serif'],
  [
    "griun-pol-sensibility",
    '"MGT Griun Pol Sensibility", "Malgun Gothic", sans-serif',
  ],
  ["nanum-gothic", '"MGT Nanum Gothic", "Malgun Gothic", sans-serif'],
  ["nanum-myeongjo", '"MGT Nanum Myeongjo", "Malgun Gothic", serif'],
  [
    "nanum-barun-gothic",
    '"MGT Nanum Barun Gothic", "Malgun Gothic", sans-serif',
  ],
  ["seoul-namsan", '"MGT Seoul Namsan", "Malgun Gothic", sans-serif'],
  [
    "seoul-namsan-vertical",
    '"MGT Seoul Namsan Vertical", "Malgun Gothic", sans-serif',
  ],
  ["seoul-hangang", '"MGT Seoul Hangang", "Malgun Gothic", serif'],
]);

export function buildPageExportBlocks(
  page: MangaPage,
  outputWidth: number,
  outputHeight: number,
  customFamilyById: Map<string, string>,
): PageExportBlock[] {
  const pageWidth = Math.max(1, page.width || outputWidth);
  const pageHeight = Math.max(1, page.height || outputHeight);
  const scaleX = outputWidth / pageWidth;
  const scaleY = outputHeight / pageHeight;
  const fontScale = Math.min(scaleX, scaleY);
  return page.blocks
    .map((block) =>
      buildPageExportBlock(
        block,
        { width: pageWidth, height: pageHeight },
        scaleX,
        scaleY,
        fontScale,
        customFamilyById,
      ),
    )
    .filter((block): block is PageExportBlock => Boolean(block));
}

function buildPageExportBlock(
  block: TranslationBlock,
  pageSize: { width: number; height: number },
  scaleX: number,
  scaleY: number,
  fontScale: number,
  customFamilyById: Map<string, string>,
): PageExportBlock | null {
  const text = block.translatedText || block.sourceText || "";
  if (!text.trim()) {
    return null;
  }
  const renderBbox = resolveEffectiveRenderBbox(block, pageSize, text);
  const rect = bboxToPixels(renderBbox, pageSize.width, pageSize.height);
  return {
    text,
    rect: {
      left: rect.x * scaleX,
      top: rect.y * scaleY,
      width: Math.max(1, rect.w * scaleX),
      height: Math.max(1, rect.h * scaleY),
    },
    renderDirection:
      normalizeRenderDirection(block.renderDirection, "horizontal") ===
      "vertical"
        ? "vertical"
        : "horizontal",
    rotationDeg: block.rotationDeg
      ? clamp(Math.round(block.rotationDeg), -30, 30)
      : 0,
    fontFamily: resolveExportBlockFontFamily(
      block.fontFamily,
      customFamilyById,
    ),
    fontSizePx: Math.max(10, Math.round((block.fontSizePx || 20) * fontScale)),
    lineHeight: Math.max(1, block.lineHeight || 1.18),
    letterSpacing: Number.isFinite(block.letterSpacing)
      ? (block.letterSpacing as number)
      : 0,
    textAlign: block.textAlign || "center",
    textColor: normalizeExportColor(block.textColor, "#000000"),
    outlineColor: normalizeExportColor(block.outlineColor, "#ffffff"),
    bold: Boolean(block.bold),
    italic: Boolean(block.italic),
    outlineWidthScale:
      block.outlineWidthScale == null
        ? 1
        : Math.max(0, block.outlineWidthScale),
    autoFitText: block.autoFitText ?? true,
  };
}

function resolveExportBlockFontFamily(
  value: string | undefined,
  customFamilyById?: Map<string, string>,
): string {
  if (value && customFamilyById?.has(value)) {
    return `"${customFamilyById.get(value)}", "Malgun Gothic", sans-serif`;
  }
  return (
    EXPORT_FONT_FAMILY_BY_ID.get(value ?? "") ?? DEFAULT_EXPORT_FONT_FAMILY
  );
}

function normalizeExportColor(
  value: string | undefined,
  fallback: string,
): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}
