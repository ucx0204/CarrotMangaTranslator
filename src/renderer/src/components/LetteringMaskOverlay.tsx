import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { letteringMaskSvg } from "../../../shared/generatedLetteringMask";
import type { LetteringTool } from "../../../shared/generatedLetteringMaskTypes";
import {
  matrix3dToCss,
  rectToQuadMatrix3d,
} from "../../../shared/perspectiveTransformMath";
import { WarpedTextContent } from "./WarpedTextContent";
export function LetteringMaskOverlay({
  block,
  page,
  tool,
}: {
  block: TranslationBlock;
  page: MangaPage;
  tool: LetteringTool;
}): React.JSX.Element | null {
  if (!tool.showMask) return null;
  const artwork = block.generatedLettering;
  const source = letteringMaskSvg(
    artwork?.maskStrokes?.filter((stroke) => stroke.space === tool.space) ?? [],
    tool.space === "page" ? artwork?.occlusionPolygons : [],
  )
    .replace(
      /fill="(black|white)"/g,
      (_, color: string) => `fill="${color === "black" ? "white" : "black"}"`,
    )
    .replace(
      /stroke="(black|white)"/g,
      (_, color: string) => `stroke="${color === "black" ? "white" : "black"}"`,
    );
  const maskStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    background: "var(--accent-hi)",
    opacity: 0.45,
    maskImage: `url("data:image/svg+xml,${encodeURIComponent(source)}")`,
    maskMode: "luminance",
    maskSize: "100% 100%",
  };
  return (
    <foreignObject
      width={page.width}
      height={page.height}
      transform={`scale(${1000 / page.width} ${1000 / page.height})`}
      pointerEvents="none"
    >
      <div
        style={{ position: "relative", width: page.width, height: page.height }}
      >
        {tool.space === "page" ? (
          <div style={maskStyle} />
        ) : (
          <AssetMaskView block={block} page={page}>
            <div style={maskStyle} />
          </AssetMaskView>
        )}
      </div>
    </foreignObject>
  );
}
function AssetMaskView({
  block,
  page,
  children,
}: {
  block: TranslationBlock;
  page: MangaPage;
  children: React.ReactNode;
}) {
  const box = block.renderBbox ?? block.bbox;
  const width = (box.w * page.width) / 1000,
    height = (box.h * page.height) / 1000;
  const perspective = block.perspectiveTransform
    ? matrix3dToCss(
        rectToQuadMatrix3d(width, height, block.perspectiveTransform.corners),
      )
    : undefined;
  return (
    <div
      style={{
        position: "absolute",
        left: (box.x * page.width) / 1000,
        top: (box.y * page.height) / 1000,
        width,
        height,
        transform: `rotate(${block.rotationDeg ?? 0}deg)`,
      }}
    >
      <div
        className="overlay-transform-content"
        style={
          perspective
            ? { transform: perspective, transformOrigin: "0 0" }
            : undefined
        }
      >
        <WarpedTextContent
          width={width}
          height={height}
          transform={block.warpTransform}
          preview={false}
        >
          {children}
        </WarpedTextContent>
      </div>
    </div>
  );
}
