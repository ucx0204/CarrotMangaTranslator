import type { ImageStageProps, RetouchStageModel } from "./imageStageTypes";

type RetouchModelInput = Pick<ImageStageProps, "maskStrokes">;

export function resolveRetouchStageModel({
  maskStrokes = [],
}: RetouchModelInput): RetouchStageModel {
  return {
    maskStrokePaths: maskStrokes
      .map((stroke) => ({
        path: pointsToPath(stroke.points),
        width: Math.max(1, stroke.radiusPx * 2),
      }))
      .filter((stroke) => stroke.path),
  };
}

export function resolveStageClassName({
  blockPointerDisabled,
  regionSelectionActive,
  retouchCursor,
  stageTool,
}: {
  blockPointerDisabled: boolean;
  regionSelectionActive: boolean;
  retouchCursor: ImageStageProps["retouchCursor"];
  stageTool?: ImageStageProps["stageTool"];
}): string {
  return [
    "image-stage",
    regionSelectionActive ? "selecting-region" : "",
    blockPointerDisabled ? "editing-mask" : "",
    resolveRetouchToolClassName(retouchCursor),
    stageTool === "hand" ? "stage-tool-hand" : "",
    stageTool === "block" ? "stage-tool-block" : "",
    stageTool === "perspective" ? "stage-tool-perspective" : "",
    stageTool === "curve" ? "stage-tool-curve" : "",
    stageTool === "warp" ? "stage-tool-warp" : "",
    stageTool === "bubble" ? "stage-tool-bubble" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function resolveRetouchToolClassName(
  retouchCursor: ImageStageProps["retouchCursor"],
): string {
  if (!retouchCursor) return "";
  return retouchCursor.mode === "rectangle" ||
    retouchCursor.mode === "ellipse" ||
    retouchCursor.mode === "eraser-rectangle"
    ? "retouch-shape-tool-enabled"
    : "retouch-tool-enabled";
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
