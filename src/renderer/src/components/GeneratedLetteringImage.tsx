import { useLetteringPageMask } from "../hooks/useLetteringPageMask";
import type { OverlayBlockRenderModel } from "./overlayBlockModel";
import React from "react";
import { letteringMaskSvg } from "../../../shared/generatedLetteringMask";
import type { TranslationBlock } from "../../../shared/textTypes";

export function GeneratedLetteringImage({
  block,
  className,
}: {
  block: TranslationBlock;
  className: string;
}): React.JSX.Element {
  const artwork = block.generatedLettering;
  const mask = React.useMemo(() => {
    const strokes =
      artwork?.maskStrokes?.filter((stroke) => stroke.space === "asset") ?? [];
    return strokes.length
      ? `url("data:image/svg+xml,${encodeURIComponent(letteringMaskSvg(strokes))}")`
      : undefined;
  }, [artwork?.maskStrokes]);
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
        {chrome}
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
