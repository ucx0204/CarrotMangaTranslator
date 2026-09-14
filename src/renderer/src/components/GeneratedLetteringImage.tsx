import { useLetteringPageMask } from "../hooks/useLetteringPageMask";
import type { OverlayBlockRenderModel } from "./overlayBlockModel";
import React from "react";
import { ImageGenerationBlockedOverlay } from "./ImageGenerationBlockedOverlay";
import {
  letteringMaskSvg,
  letteringPaintSvg,
} from "../../../shared/generatedLetteringMask";
import type { TranslationBlock } from "../../../shared/textTypes";

export function GeneratedLetteringImage({
  block,
  className,
  nativeSize,
}: {
  block: TranslationBlock;
  className: string;
  nativeSize: { width: number; height: number };
}): React.JSX.Element {
  const artwork = block.generatedLettering;
  const mask = React.useMemo(() => {
    const strokes =
      artwork?.maskStrokes?.filter((stroke) => stroke.space === "asset") ?? [];
    return strokes.length
      ? `url("data:image/svg+xml,${encodeURIComponent(letteringMaskSvg(strokes))}")`
      : undefined;
  }, [artwork?.maskStrokes]);
  const paintStrokes = artwork?.paintStrokes;
  const paint = React.useMemo(
    () =>
      paintStrokes?.length
        ? `data:image/svg+xml,${encodeURIComponent(letteringPaintSvg(paintStrokes))}`
        : undefined,
    [paintStrokes],
  );
  const width = artwork?.outline?.width ?? 0;
  if (paint || width > 0)
    return (
      <CorrectedLetteringImage
        block={block}
        className={className}
        nativeSize={nativeSize}
        mask={mask}
        paint={paint}
      />
    );
  return (
    <img
      alt={block.translatedText}
      draggable={false}
      src={artwork?.dataUrl}
      className={className}
      style={{
        opacity: block.textOpacity ?? 1,
        maskImage: mask,
        maskMode: "luminance",
        maskSize: "100% 100%",
      }}
    />
  );
}

function CorrectedLetteringImage({
  block,
  className,
  nativeSize,
  mask,
  paint,
}: {
  block: TranslationBlock;
  className: string;
  nativeSize: { width: number; height: number };
  mask?: string;
  paint?: string;
}) {
  const id = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const filterId = `lettering-outline-${id}`;
  const artwork = block.generatedLettering;
  const width = artwork?.outline?.width ?? 0;
  return (
    <>
      {width > 0 ? (
        <LetteringOutlineFilter
          id={filterId}
          width={width}
          color={artwork?.outline?.color ?? "#ffffff"}
          nativeSize={nativeSize}
        />
      ) : null}
      <div
        className={className}
        style={{
          opacity: block.textOpacity ?? 1,
          filter: width > 0 ? `url(#${filterId})` : undefined,
        }}
      >
        <div
          className={className}
          style={{
            maskImage: mask,
            maskMode: "luminance",
            maskSize: "100% 100%",
          }}
        >
          <img
            alt={block.translatedText}
            draggable={false}
            src={artwork?.dataUrl}
            className={className}
          />
          {paint ? (
            <img
              alt=""
              aria-hidden="true"
              draggable={false}
              src={paint}
              className={className}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function LetteringOutlineFilter({
  id,
  width,
  color,
  nativeSize,
}: {
  id: string;
  width: number;
  color: string;
  nativeSize: { width: number; height: number };
}) {
  const x = width / Math.max(1, nativeSize.width);
  const y = width / Math.max(1, nativeSize.height);
  return (
    <svg
      aria-hidden="true"
      style={{ position: "absolute", width: 0, height: 0 }}
    >
      <filter
        id={id}
        primitiveUnits="objectBoundingBox"
        colorInterpolationFilters="sRGB"
        x={-x * 2}
        y={-y * 2}
        width={1 + x * 4}
        height={1 + y * 4}
      >
        <feMorphology
          in="SourceAlpha"
          operator="dilate"
          radius={`${x} ${y}`}
          result="edge"
        />
        <feFlood floodColor={color} result="color" />
        <feComposite in="color" in2="edge" operator="in" result="outline" />
        <feMerge>
          <feMergeNode in="outline" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </svg>
  );
}

export function LetteringPageFrame({
  block,
  model,
  chrome,
  children,
}: {
  block: TranslationBlock;
  model: OverlayBlockRenderModel;
  chrome?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pageMask = useLetteringPageMask(
    block,
    model.layout.rect,
    model.stageSize,
  );
  return (
    <>
      <div className="overlay-transform-content" style={model.contentStyle}>
        {chrome && model.textVisible && block.imageGenerationBlocked ? (
          <ImageGenerationBlockedOverlay model={model} />
        ) : (
          chrome
        )}
        {!pageMask ? children : null}
      </div>
      {pageMask ? (
        <div style={pageMask}>
          <div className="overlay-transform-content" style={model.contentStyle}>
            {children}
          </div>
        </div>
      ) : null}
    </>
  );
}
