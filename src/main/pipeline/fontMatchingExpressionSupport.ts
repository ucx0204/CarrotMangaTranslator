import type { BBox } from "../../shared/textTypes";
import {
  prepareFontMatchingInkComponents,
  type FontMatchingRasterPage,
} from "./fontMatchingPagePixelPreprocessing";

export const FONT_EXPRESSION_COMPONENT_SIZE = 64;
const INK_SIZE = 48;
const MAXIMUM_COMPONENTS = 16;

type InkMask = NonNullable<ReturnType<typeof prepareFontMatchingInkComponents>>;
type InkComponent = InkMask["components"][number];

/** No OCR text, glyph count, line orientation, or semantic role is required. */
export function prepareFontExpressionSupport(
  page: FontMatchingRasterPage,
  bbox: BBox,
  signal?: AbortSignal,
) {
  const ink = prepareFontMatchingInkComponents(page, bbox, signal);
  if (!ink) return null;
  const eligible = ink.components
    .filter((component) => isEligibleComponent(component, ink))
    .sort((a, b) => b.area - a.area || a.y1 - b.y1 || a.x1 - b.x1);
  const largestArea = eligible[0]?.area ?? 0;
  const components = eligible
    .filter((component) => component.area >= largestArea * 0.07)
    .slice(0, MAXIMUM_COMPONENTS);
  if (components.length === 0) return null;
  const values = new Float32Array(
    components.length * FONT_EXPRESSION_COMPONENT_SIZE ** 2,
  );
  for (const [index, component] of components.entries()) {
    signal?.throwIfAborted();
    renderComponent(values, index, component, ink);
  }
  return { values, count: components.length, threshold: ink.threshold };
}

function isEligibleComponent(c: InkComponent, ink: InkMask): boolean {
  const width = c.x2 - c.x1;
  const height = c.y2 - c.y1;
  const aspect = Math.max(width / height, height / width);
  if (c.area < 8 || Math.min(width, height) < 3 || aspect > 4) return false;
  const touchesEdge =
    c.x1 === 0 || c.y1 === 0 || c.x2 === ink.width || c.y2 === ink.height;
  return !(touchesEdge && aspect > 2);
}

function renderComponent(
  destination: Float32Array,
  index: number,
  component: InkComponent,
  ink: InkMask,
) {
  const width = component.x2 - component.x1;
  const height = component.y2 - component.y1;
  const scale = INK_SIZE / Math.max(width, height);
  const targetWidth = Math.max(1, roundEven(width * scale));
  const targetHeight = Math.max(1, roundEven(height * scale));
  const offsetX = Math.floor(
    (FONT_EXPRESSION_COMPONENT_SIZE - targetWidth) / 2,
  );
  const offsetY = Math.floor(
    (FONT_EXPRESSION_COMPONENT_SIZE - targetHeight) / 2,
  );
  const offset = index * FONT_EXPRESSION_COMPONENT_SIZE ** 2;
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      destination[
        offset + (y + offsetY) * FONT_EXPRESSION_COMPONENT_SIZE + x + offsetX
      ] = sampleComponent(
        ink,
        component,
        ((x + 0.5) * width) / targetWidth - 0.5,
        ((y + 0.5) * height) / targetHeight - 0.5,
      );
    }
  }
}

function sampleComponent(ink: InkMask, c: InkComponent, x: number, y: number) {
  const clippedX = Math.max(0, Math.min(c.x2 - c.x1 - 1, x));
  const clippedY = Math.max(0, Math.min(c.y2 - c.y1 - 1, y));
  const x0 = Math.floor(clippedX),
    y0 = Math.floor(clippedY);
  const x1 = Math.min(c.x2 - c.x1 - 1, x0 + 1);
  const y1 = Math.min(c.y2 - c.y1 - 1, y0 + 1);
  const sx = clippedX - x0,
    sy = clippedY - y0;
  const at = (px: number, py: number) =>
    Number(ink.labels[(py + c.y1) * ink.width + px + c.x1] === c.label);
  return (
    (at(x0, y0) * (1 - sx) + at(x1, y0) * sx) * (1 - sy) +
    (at(x0, y1) * (1 - sx) + at(x1, y1) * sx) * sy
  );
}

function roundEven(value: number) {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + (floor % 2) : Math.round(value);
}
