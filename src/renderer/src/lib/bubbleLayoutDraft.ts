import {
  isUsableBubbleLayout,
  type BubbleLayout,
} from "../../../shared/bubbleLayout";
import { resolveDisjointBubbleLayout } from "../../../shared/bubbleLayoutDisjoint";
import type { BBox, Point, TranslationBlock } from "../../../shared/textTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import { buildManualBubbleLayoutPatch } from "./manualBubbleLayout";
import type {
  BubbleLayoutDraftPreview,
  BubbleLayoutDraftShape,
  BubbleLayoutDraftSnapshot,
} from "./workspaceInteractionPreview";

const DEFAULT_BRUSH_RADIUS = 36;

export function createBubbleLayoutDraft(
  block: TranslationBlock,
  page: MangaPage,
): BubbleLayoutDraftPreview {
  const shape = resolveBlockBubbleLayoutShape(block, page);
  return {
    blockId: block.id,
    brushRadius: DEFAULT_BRUSH_RADIUS,
    direction: block.bubbleLayout?.direction ?? block.renderDirection,
    dirty: false,
    history: [],
    hoverPoint: null,
    mode: shape ? "add" : "polygon",
    notice: null,
    points: [],
    shape,
    stroke: null,
  };
}

export function appendBubbleLayoutPolygonPoint(
  draft: BubbleLayoutDraftPreview,
  point: Point,
): BubbleLayoutDraftPreview {
  const points = [...draft.points, point];
  const patch = buildManualBubbleLayoutPatch(points, draft.direction);
  return {
    ...draft,
    dirty: patch ? true : draft.dirty,
    history: [...draft.history, snapshotBubbleLayoutDraft(draft)].slice(-80),
    hoverPoint: point,
    notice: null,
    points,
    shape: patch ?? draft.shape,
  };
}

export function undoBubbleLayoutDraft(
  draft: BubbleLayoutDraftPreview,
): BubbleLayoutDraftPreview {
  const snapshot = draft.history.at(-1);
  if (!snapshot) return draft;
  return {
    ...draft,
    ...snapshot,
    history: draft.history.slice(0, -1),
    stroke: null,
  };
}

export function resolveBubbleLayoutDraftShapeForApply(
  draft: BubbleLayoutDraftPreview,
): BubbleLayoutDraftShape | null {
  return draft.mode === "polygon"
    ? buildManualBubbleLayoutPatch(draft.points, draft.direction)
    : draft.shape;
}

export function snapshotBubbleLayoutDraft(
  draft: Pick<BubbleLayoutDraftPreview, "dirty" | "points" | "shape">,
): BubbleLayoutDraftSnapshot {
  return {
    dirty: draft.dirty,
    points: draft.points,
    shape: draft.shape,
  };
}

function resolveBlockBubbleLayoutShape(
  block: TranslationBlock,
  page: MangaPage,
): BubbleLayoutDraftShape | null {
  if (!isUsableBubbleLayout(block.bubbleLayout)) return null;
  const renderBbox = resolveNormalizedRenderBbox(block, page);
  if (!renderBbox) return null;
  const physicalWidth = (renderBbox.w * page.width) / 1000;
  const physicalHeight = (renderBbox.h * page.height) / 1000;
  const layout =
    resolveDisjointBubbleLayout(block.bubbleLayout, {
      blockExtentPx:
        block.bubbleLayout.direction === "horizontal"
          ? physicalHeight
          : physicalWidth,
      inlineExtentPx:
        block.bubbleLayout.direction === "horizontal"
          ? physicalWidth
          : physicalHeight,
    }) ?? block.bubbleLayout;
  return {
    bubbleLayout: cloneBubbleLayout(layout),
    renderBbox,
    renderBboxSpace: "normalized_1000",
  };
}

function resolveNormalizedRenderBbox(
  block: TranslationBlock,
  page: MangaPage,
): BBox | null {
  const bbox = block.renderBbox ?? block.bbox;
  const space = block.renderBbox
    ? (block.renderBboxSpace ?? block.bboxSpace)
    : block.bboxSpace;
  const normalized =
    space === "pixels"
      ? {
          x: (bbox.x * 1000) / Math.max(1, page.width),
          y: (bbox.y * 1000) / Math.max(1, page.height),
          w: (bbox.w * 1000) / Math.max(1, page.width),
          h: (bbox.h * 1000) / Math.max(1, page.height),
        }
      : { ...bbox };
  return isValidBbox(normalized) ? normalized : null;
}

function cloneBubbleLayout(layout: BubbleLayout): BubbleLayout {
  return {
    ...layout,
    regions: layout.regions.map((region) => ({
      spans: region.spans.map((span) => ({ ...span })),
    })),
  };
}

function isValidBbox(bbox: BBox): boolean {
  return (
    [bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite) &&
    bbox.w > 0 &&
    bbox.h > 0
  );
}
