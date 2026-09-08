import { letteringMaskSvg } from "../../../shared/generatedLetteringMask";
import type { LetteringMaskStroke } from "../../../shared/generatedLetteringMaskTypes";
import type { BBox } from "../../../shared/textTypes";

type Selection = {
  sourceBbox: BBox;
  selectionStrokes?: LetteringMaskStroke[];
  exclusionStrokes?: LetteringMaskStroke[];
};
const inner = (svg: string) => svg.slice(svg.indexOf(">") + 1, -6);
export function paintedSelectionSvg(strokes: LetteringMaskStroke[]): string {
  return letteringMaskSvg(strokes).replace(/white|black/g, (color) =>
    color === "white" ? "black" : "white",
  );
}
export function regionReviewSelectionSvg(
  regions: Selection[],
  excluded: LetteringMaskStroke[],
): string {
  if (
    !regions.some(
      (region) =>
        region.selectionStrokes?.length || region.exclusionStrokes?.length,
    )
  )
    return letteringMaskSvg(excluded);
  const definitions = regions
    .map((region, index) => {
      const selected = region.selectionStrokes?.length
        ? inner(paintedSelectionSvg(region.selectionStrokes))
        : `<rect width="1000" height="1000" fill="white"/>`;
      return `<mask id="selection${index}" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000">${selected}</mask><mask id="excluded${index}" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000">${inner(letteringMaskSvg(region.exclusionStrokes ?? []))}</mask>`;
    })
    .join("");
  const shapes = regions
    .map(
      ({ sourceBbox: box }, index) =>
        `<g mask="url(#excluded${index})"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="white" mask="url(#selection${index})"/></g>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none"><defs>${definitions}<mask id="excluded" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000">${inner(letteringMaskSvg(excluded))}</mask></defs><rect width="1000" height="1000" fill="black"/><g mask="url(#excluded)">${shapes}</g></svg>`;
}
export function paintedSelectionBounds(strokes: LetteringMaskStroke[]): BBox {
  let left = 1000,
    top = 1000,
    right = 0,
    bottom = 0;
  for (const stroke of strokes)
    for (const point of stroke.points) {
      left = Math.min(left, Math.max(0, point.x - stroke.radiusX));
      top = Math.min(top, Math.max(0, point.y - stroke.radiusY));
      right = Math.max(right, Math.min(1000, point.x + stroke.radiusX));
      bottom = Math.max(bottom, Math.min(1000, point.y + stroke.radiusY));
    }
  return { x: left, y: top, w: right - left, h: bottom - top };
}
export function transformSelectionStrokes(
  strokes: LetteringMaskStroke[],
  from: BBox,
  to: BBox,
): LetteringMaskStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    radiusX: (stroke.radiusX * to.w) / from.w,
    radiusY: (stroke.radiusY * to.h) / from.h,
    points: stroke.points.map((point) => ({
      x: to.x + ((point.x - from.x) * to.w) / from.w,
      y: to.y + ((point.y - from.y) * to.h) / from.h,
    })),
  }));
}
