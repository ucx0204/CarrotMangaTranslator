import React from "react";
import type { WarpTransform } from "../../../shared/textTypes";
import { getWarpDisplacementMap } from "../lib/warpDisplacementMap";

export function WarpedTextContent({
  children,
  height,
  preview = false,
  transform,
  width,
}: {
  children: React.ReactNode;
  height: number;
  preview?: boolean;
  transform?: WarpTransform;
  width: number;
}): React.JSX.Element {
  const generatedId = React.useId();
  const filterId = React.useMemo(
    () => `text-warp-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [generatedId],
  );
  const map = React.useMemo(
    () => getWarpDisplacementMap(transform, { height, width }, preview),
    [height, preview, transform, width],
  );
  if (!map) return <>{children}</>;
  const filterBounds = {
    x: map.bounds.left * width,
    y: map.bounds.top * height,
    width: map.bounds.width * width,
    height: map.bounds.height * height,
  };
  return (
    <>
      <svg aria-hidden="true" className="warp-filter-definition">
        <filter
          id={filterId}
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
          height={filterBounds.height}
          primitiveUnits="userSpaceOnUse"
          width={filterBounds.width}
          x={filterBounds.x}
          y={filterBounds.y}
        >
          <feImage
            height={filterBounds.height}
            href={map.dataUrl}
            preserveAspectRatio="none"
            result="warp-map"
            width={filterBounds.width}
            x={filterBounds.x}
            y={filterBounds.y}
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="warp-map"
            scale={map.scale}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
      <img
        alt=""
        aria-hidden="true"
        className="warp-map-preload"
        data-warp-map=""
        height={map.height}
        src={map.dataUrl}
        width={map.width}
      />
      <div
        className="warped-text-content"
        style={{ filter: `url(#${filterId})` }}
      >
        {children}
      </div>
    </>
  );
}
