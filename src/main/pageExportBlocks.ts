import {
  bboxToPixels,
  clamp,
  normalizeRenderDirection,
  normalizeRotationDeg,
  resolveEffectiveRenderBbox,
  resolveFontWidthScale,
} from "../shared/geometry";
import {
  matrix3dToCss,
  normalizeCurveLayout,
  normalizePerspectiveTransform,
  quadraticPointAt,
  quadraticTangentAt,
  rectToQuadMatrix3d,
} from "../shared/blockTransforms";
import {
  DEFAULT_BLOCK_FONT_ID,
  DEFAULT_BLOCK_FONT_STACK,
  resolveBuiltInBlockFontFamily,
} from "../shared/blockFontCatalog";
import type { MangaPage } from "../shared/libraryTypes";
import { parseRichText, type TextStyleRun } from "../shared/richTextMarkup";
import type {
  CurveLayout,
  Point,
  QuadraticCurvePath,
  TranslationBlock,
} from "../shared/textTypes";

const CURVE_ARC_SEGMENTS = 96;

type PageExportCurveSample = {
  distance: number;
  x: number;
  y: number;
  tangentX: number;
  tangentY: number;
};

type PageExportCurveLayout = Pick<
  CurveLayout,
  "alignment" | "offsetEm" | "orientation"
> & {
  fitSpacing: boolean;
  samples: PageExportCurveSample[];
  pathLength: number;
};

export type PageExportBlock = {
  type: TranslationBlock["type"];
  text: string;
  runs: TextStyleRun[];
  rect: { left: number; top: number; width: number; height: number };
  renderDirection: "horizontal" | "vertical";
  rotationDeg: number;
  perspectiveMatrix3d?: string;
  curveLayout?: PageExportCurveLayout;
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  letterSpacing: number;
  fontWidthScale: number;
  textAlign: "left" | "center" | "right";
  textColor: string;
  textOpacity: number;
  outlineColor: string;
  bold: boolean;
  italic: boolean;
  outlineWidthScale: number;
  autoFitText: boolean;
};

export function buildPageExportBlocks(
  page: MangaPage,
  outputWidth: number,
  outputHeight: number,
  customFamilyById: Map<string, string>,
  defaultFontId: string = DEFAULT_BLOCK_FONT_ID,
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
        defaultFontId,
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
  defaultFontId: string,
): PageExportBlock | null {
  const rawText = block.translatedText || block.sourceText || "";
  if (!rawText.trim()) {
    return null;
  }
  const { runs, plainText } = parseRichText(
    rawText,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  const renderBbox = resolveEffectiveRenderBbox(block, pageSize, plainText);
  const rect = bboxToPixels(renderBbox, pageSize.width, pageSize.height);
  const exportRect = {
    left: rect.x * scaleX,
    top: rect.y * scaleY,
    width: Math.max(1, rect.w * scaleX),
    height: Math.max(1, rect.h * scaleY),
  };
  return {
    type: block.type,
    text: plainText,
    runs,
    rect: exportRect,
    renderDirection:
      normalizeRenderDirection(block.renderDirection, "horizontal") ===
      "vertical"
        ? "vertical"
        : "horizontal",
    rotationDeg: resolveExportRotation(block.rotationDeg),
    ...resolveExportPerspective(block, exportRect.width, exportRect.height),
    ...resolveExportCurveLayout(block, exportRect.width, exportRect.height),
    fontFamily: resolveExportBlockFontFamily(
      block.fontFamily,
      customFamilyById,
      defaultFontId,
    ),
    fontSizePx: Math.max(10, Math.floor((block.fontSizePx || 20) * fontScale)),
    // Keep parity with the editor preview, which allows a 0.8–3 line-height
    // range. Clamping the floor to 1 here silently reset tight line spacing.
    lineHeight: clamp(Number(block.lineHeight ?? 1.18), 0.8, 3),
    letterSpacing: Number.isFinite(block.letterSpacing)
      ? (block.letterSpacing as number)
      : 0,
    fontWidthScale: resolveFontWidthScale(block.fontWidthScale),
    textAlign: block.textAlign || "center",
    textColor: normalizeExportColor(block.textColor, "#000000"),
    textOpacity: clamp(Number(block.textOpacity ?? 1), 0, 1),
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

function resolveExportRotation(value: number | undefined): number {
  return normalizeRotationDeg(value);
}

function resolveExportPerspective(
  block: TranslationBlock,
  width: number,
  height: number,
): Pick<PageExportBlock, "perspectiveMatrix3d"> | Record<string, never> {
  const transform = block.perspectiveTransform;
  if (!transform) {
    return {};
  }
  const normalized = normalizePerspectiveTransform(transform);
  return {
    perspectiveMatrix3d: matrix3dToCss(
      rectToQuadMatrix3d(width, height, normalized.corners),
    ),
  };
}

function resolveExportCurveLayout(
  block: TranslationBlock,
  width: number,
  height: number,
): Pick<PageExportBlock, "curveLayout"> | Record<string, never> {
  if (!block.curveLayout) {
    return {};
  }
  const layout = normalizeCurveLayout(block.curveLayout);
  const path = scaleCurvePath(layout.path, width, height, layout.reversed);
  const samples = buildCurveSamples(path);
  return {
    curveLayout: {
      alignment: layout.alignment,
      offsetEm: layout.offsetEm,
      orientation: layout.orientation,
      fitSpacing: layout.fitSpacing === true,
      samples,
      pathLength: samples.at(-1)?.distance ?? 0,
    },
  };
}

function scaleCurvePath(
  path: QuadraticCurvePath,
  width: number,
  height: number,
  reversed = false,
): QuadraticCurvePath {
  const start = scaleLocalPoint(
    reversed ? path.end : path.start,
    width,
    height,
  );
  const end = scaleLocalPoint(reversed ? path.start : path.end, width, height);
  return {
    type: "quadratic",
    start,
    control: scaleLocalPoint(path.control, width, height),
    end,
  };
}

function scaleLocalPoint(point: Point, width: number, height: number): Point {
  return { x: point.x * width, y: point.y * height };
}

function buildCurveSamples(path: QuadraticCurvePath): PageExportCurveSample[] {
  const samples: PageExportCurveSample[] = [];
  let previous = quadraticPointAt(path, 0);
  let distance = 0;
  for (let index = 0; index <= CURVE_ARC_SEGMENTS; index += 1) {
    const t = index / CURVE_ARC_SEGMENTS;
    const point = index === 0 ? previous : quadraticPointAt(path, t);
    if (index > 0) {
      distance += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    const tangent = quadraticTangentAt(path, t);
    samples.push({
      distance,
      x: point.x,
      y: point.y,
      tangentX: tangent.x,
      tangentY: tangent.y,
    });
    previous = point;
  }
  return samples;
}

function resolveExportBlockFontFamily(
  value: string | undefined,
  customFamilyById?: Map<string, string>,
  defaultFontId: string = DEFAULT_BLOCK_FONT_ID,
): string {
  const explicitFamily = resolveConcreteExportFontFamily(
    value,
    customFamilyById,
  );
  if (explicitFamily) {
    return explicitFamily;
  }
  if (defaultFontId === DEFAULT_BLOCK_FONT_ID) {
    return DEFAULT_BLOCK_FONT_STACK;
  }
  return (
    resolveConcreteExportFontFamily(defaultFontId, customFamilyById) ??
    DEFAULT_BLOCK_FONT_STACK
  );
}

function resolveConcreteExportFontFamily(
  value: string | undefined,
  customFamilyById?: Map<string, string>,
): string | undefined {
  if (!value || value === DEFAULT_BLOCK_FONT_ID) {
    return undefined;
  }
  if (customFamilyById?.has(value)) {
    return `"${customFamilyById.get(value)}", "Malgun Gothic", sans-serif`;
  }
  return resolveBuiltInBlockFontFamily(value);
}

function normalizeExportColor(
  value: string | undefined,
  fallback: string,
): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}
