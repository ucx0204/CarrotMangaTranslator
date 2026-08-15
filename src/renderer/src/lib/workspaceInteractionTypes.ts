export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export type PerspectiveHandle =
  | "tl"
  | "top"
  | "tr"
  | "right"
  | "br"
  | "bottom"
  | "bl"
  | "left";

type CurveHandle = "start" | "control" | "end";

type WarpDragMode = `warp-points-${string}`;

export type DragMode =
  | "move"
  | "resize"
  | `resize-${ResizeHandle}`
  | "rotate"
  | `perspective-${PerspectiveHandle}`
  | `curve-${CurveHandle}`
  | WarpDragMode;

export type DragHud = {
  mode: DragMode;
  label: string;
  invalid?: boolean;
};
