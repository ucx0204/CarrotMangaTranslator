import type { ImageStageProps, RetouchStageModel } from "./imageStageTypes";

type RetouchModelInput = Pick<
  ImageStageProps,
  "maskStrokes" | "page" | "retouchCursor" | "retouchPreview" | "stageSize"
>;

export function resolveRetouchStageModel({
  maskStrokes = [],
  page,
  retouchCursor = null,
  retouchPreview = null,
  stageSize,
}: RetouchModelInput): RetouchStageModel {
  const cursorScaleX = stageSize
    ? stageSize.width / Math.max(1, page.width)
    : 1;
  const cursorScaleY = stageSize
    ? stageSize.height / Math.max(1, page.height)
    : 1;
  const cursorRadius = retouchCursor
    ? Math.max(3, retouchCursor.radiusPx * Math.min(cursorScaleX, cursorScaleY))
    : 0;
  return {
    cursorRadius,
    cursorScaleX,
    cursorScaleY,
    cursorVisible: Boolean(retouchCursor?.point && stageSize),
    maskStrokePaths: maskStrokes
      .map((stroke) => ({
        path: pointsToPath(stroke.points),
        width: Math.max(1, stroke.radiusPx * 2),
      }))
      .filter((stroke) => stroke.path),
    previewPath: retouchPreview?.points.length
      ? pointsToPath(retouchPreview.points)
      : "",
    previewStrokeWidth: retouchPreview
      ? Math.max(1, retouchPreview.radiusPx * 2)
      : 0,
  };
}

export function resolveStageClassName({
  blockPointerDisabled,
  cursorVisible,
  regionSelectionActive,
  retouchCursor,
}: {
  blockPointerDisabled: boolean;
  cursorVisible: boolean;
  regionSelectionActive: boolean;
  retouchCursor: ImageStageProps["retouchCursor"];
}): string {
  return [
    "image-stage",
    regionSelectionActive ? "selecting-region" : "",
    blockPointerDisabled ? "editing-mask" : "",
    retouchCursor ? "retouch-tool-enabled" : "",
    cursorVisible ? "retouch-cursor-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function pointsToPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return "";
  }
  if (points.length === 1) {
    const point = points[0];
    return `M ${point.x} ${point.y} L ${point.x + 0.01} ${point.y}`;
  }
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}
