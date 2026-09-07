import React from "react";
import { letteringMaskSvg } from "../../../shared/generatedLetteringMask";
import type { TranslationBlock } from "../../../shared/textTypes";
export function useLetteringPageMask(
  block: TranslationBlock,
  rect: { left: number; top: number; width: number; height: number },
  stage: { width: number; height: number },
): React.CSSProperties | undefined {
  const artwork = block.generatedLettering;
  return React.useMemo(() => {
    const strokes =
      artwork?.maskStrokes?.filter((stroke) => stroke.space === "page") ?? [];
    if (!strokes.length && !artwork?.occlusionPolygons?.length)
      return undefined;
    const content = letteringMaskSvg(
      strokes,
      artwork?.occlusionPolygons,
    ).replace(/^<svg[^>]*>|<\/svg>$/g, "");
    const cx = rect.width / 2,
      cy = rect.height / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rect.width} ${rect.height}"><rect width="100%" height="100%" fill="white"/><g transform="rotate(${-(block.rotationDeg ?? 0)} ${cx} ${cy}) translate(${-rect.left} ${-rect.top}) scale(${stage.width / 1000} ${stage.height / 1000})">${content}</g></svg>`;
    return {
      maskImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
      maskMode: "luminance",
      maskSize: "100% 100%",
      position: "absolute",
      inset: 0,
    };
  }, [
    artwork?.maskStrokes,
    artwork?.occlusionPolygons,
    block.rotationDeg,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    stage.width,
    stage.height,
  ]);
}
