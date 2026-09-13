import type { BBox, Point, TranslationBlock } from "./textTypes";
import { clamp } from "./bboxNormalization";

export function getActiveGeneratedLettering(
  block: Pick<
    TranslationBlock,
    "sourceText" | "translatedText" | "generatedLettering"
  >,
): TranslationBlock["generatedLettering"] | null {
  const artwork = block.generatedLettering;
  return artwork &&
    artwork.enabled !== false &&
    artwork.translatedText === block.translatedText &&
    artwork.sourceText === block.sourceText
    ? artwork
    : null;
}

/** Keep page-space masking aligned when lettering is inserted on another page. */
export function relocateGeneratedLettering(
  artwork: TranslationBlock["generatedLettering"],
  from: BBox,
  to: BBox,
): TranslationBlock["generatedLettering"] {
  if (!artwork) return undefined;
  const scaleX = to.w / from.w;
  const scaleY = to.h / from.h;
  const mapPoint = (point: Point): Point => ({
    x: clamp(to.x + (point.x - from.x) * scaleX, -10000, 10000),
    y: clamp(to.y + (point.y - from.y) * scaleY, -10000, 10000),
  });
  return {
    ...artwork,
    maskStrokes: artwork.maskStrokes?.map((stroke) =>
      stroke.space === "asset"
        ? structuredClone(stroke)
        : {
            ...stroke,
            points: stroke.points.map(mapPoint),
            radiusX: Math.min(100000, stroke.radiusX * scaleX),
            radiusY: Math.min(100000, stroke.radiusY * scaleY),
          },
    ),
    occlusionPolygons: artwork.occlusionPolygons?.map((polygon) =>
      polygon.map(mapPoint),
    ),
  };
}
