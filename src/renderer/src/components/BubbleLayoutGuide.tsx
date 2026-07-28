import React from "react";
import {
  isUsableBubbleLayout,
  isManualBubbleLayout,
  type BubbleShapeRegion,
} from "../../../shared/bubbleLayout";
import type {
  Point,
  RenderTextDirection,
  TranslationBlock,
} from "../../../shared/textTypes";
import { resolveDisjointBubbleLayout } from "../../../shared/bubbleLayoutDisjoint";

const GUIDE_VIEWBOX_SIZE = 1000;

export function BubbleLayoutGuide({
  block,
  selected,
  width,
  height,
}: {
  block: TranslationBlock;
  selected: boolean;
  width: number;
  height: number;
}): React.JSX.Element | null {
  const sourceLayout = block.bubbleLayout;
  if (!selected || !isUsableBubbleLayout(sourceLayout)) return null;
  const layout =
    resolveDisjointBubbleLayout(sourceLayout, {
      blockExtentPx: sourceLayout.direction === "horizontal" ? height : width,
      inlineExtentPx: sourceLayout.direction === "horizontal" ? width : height,
    }) ?? sourceLayout;
  const manual = isManualBubbleLayout(layout);
  return (
    <svg
      aria-hidden="true"
      className={`bubble-layout-guide ${manual ? "manual" : "automatic"}`}
      data-bubble-layout-guide={manual ? "manual" : "automatic"}
      focusable="false"
      preserveAspectRatio="none"
      viewBox={`0 0 ${GUIDE_VIEWBOX_SIZE} ${GUIDE_VIEWBOX_SIZE}`}
    >
      {layout.regions.map((region, index) => (
        <polygon
          data-bubble-region={index}
          key={index}
          points={regionPolygonPoints(region, layout.direction)}
        />
      ))}
    </svg>
  );
}

function regionPolygonPoints(
  region: BubbleShapeRegion,
  direction: RenderTextDirection,
): string {
  const leading: Point[] = [];
  const trailing: Point[] = [];
  for (const span of region.spans) {
    if (direction === "horizontal") {
      leading.push(
        { x: span.inlineStart, y: span.blockStart },
        { x: span.inlineStart, y: span.blockEnd },
      );
      trailing.unshift(
        { x: span.inlineEnd, y: span.blockEnd },
        { x: span.inlineEnd, y: span.blockStart },
      );
    } else {
      leading.push(
        { x: span.blockStart, y: span.inlineStart },
        { x: span.blockEnd, y: span.inlineStart },
      );
      trailing.unshift(
        { x: span.blockEnd, y: span.inlineEnd },
        { x: span.blockStart, y: span.inlineEnd },
      );
    }
  }
  return [...leading, ...trailing]
    .map(
      (point) =>
        `${formatCoordinate(point.x * GUIDE_VIEWBOX_SIZE)},${formatCoordinate(point.y * GUIDE_VIEWBOX_SIZE)}`,
    )
    .join(" ");
}

function formatCoordinate(value: number): string {
  return Number(value.toFixed(2)).toString();
}
