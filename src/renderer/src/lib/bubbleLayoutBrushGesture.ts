import type { Point } from "../../../shared/textTypes";
import {
  sculptBubbleLayout,
  type BubbleLayoutSculptRejectReason,
} from "./bubbleLayoutSculpt";
import { snapshotBubbleLayoutDraft } from "./bubbleLayoutDraft";
import type { BubbleLayoutDraftPreview } from "./workspaceInteractionPreview";

export function startBubbleLayoutBrushStroke(
  draft: BubbleLayoutDraftPreview,
  point: Point,
  pointerId: number,
): BubbleLayoutDraftPreview {
  if (!draft.shape || draft.mode === "polygon") return draft;
  return updateBubbleLayoutBrushPreview(
    {
      ...draft,
      notice: null,
      stroke: {
        base: snapshotBubbleLayoutDraft(draft),
        pointerId,
        points: [],
        result: "empty",
      },
    },
    [point],
  );
}

export function updateBubbleLayoutBrushStroke(
  draft: BubbleLayoutDraftPreview,
  point: Point,
): BubbleLayoutDraftPreview {
  const stroke = draft.stroke;
  if (!stroke || isSamePoint(stroke.points.at(-1), point)) {
    return { ...draft, hoverPoint: point };
  }
  return updateBubbleLayoutBrushPreview(draft, [...stroke.points, point]);
}

export function finishBubbleLayoutBrushStroke(
  draft: BubbleLayoutDraftPreview,
): {
  draft: BubbleLayoutDraftPreview;
  rejection: BubbleLayoutSculptRejectReason | null;
} {
  const stroke = draft.stroke;
  if (!stroke) return { draft, rejection: null };
  if (stroke.result !== "applied") {
    return {
      draft: {
        ...draft,
        ...stroke.base,
        hoverPoint: draft.hoverPoint,
        stroke: null,
      },
      rejection: stroke.result,
    };
  }
  return {
    draft: {
      ...draft,
      dirty: true,
      history: [...draft.history, stroke.base].slice(-80),
      notice: null,
      stroke: null,
    },
    rejection: null,
  };
}

function updateBubbleLayoutBrushPreview(
  draft: BubbleLayoutDraftPreview,
  points: Point[],
): BubbleLayoutDraftPreview {
  const stroke = draft.stroke;
  if (!stroke?.base.shape || draft.mode === "polygon") return draft;
  const result = sculptBubbleLayout({
    block: stroke.base.shape,
    mode: draft.mode,
    radius: draft.brushRadius,
    strokePoints: points,
  });
  return {
    ...draft,
    hoverPoint: points.at(-1) ?? draft.hoverPoint,
    shape: result.status === "applied" ? result.patch : stroke.base.shape,
    stroke: {
      ...stroke,
      points,
      result: result.status === "applied" ? "applied" : result.reason,
    },
  };
}

function isSamePoint(left: Point | undefined, right: Point): boolean {
  return Boolean(
    left &&
    Math.abs(left.x - right.x) < 0.25 &&
    Math.abs(left.y - right.y) < 0.25,
  );
}
