import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { Point, TranslationBlock } from "../../../shared/textTypes";
import { pagePointToLettering } from "../../../shared/generatedLetteringMask";
import type {
  LetteringTool,
  LetteringMaskStroke,
} from "../../../shared/generatedLetteringMaskTypes";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
type Controls = {
  tool: LetteringTool;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};
export function useLetteringStroke(
  page: MangaPage,
  block: TranslationBlock,
  controls: Controls,
  preview: WorkspaceInteractionPreviewStore,
) {
  const [cursor, setCursor] = React.useState<Point | null>(null);
  const stroke = React.useRef<{
    pointer: number;
    value: LetteringMaskStroke;
  } | null>(null);
  const { tool } = controls;
  const cancel = React.useCallback(() => {
    stroke.current = null;
    preview.set({ blockPreview: null });
  }, [preview]);
  React.useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      cancel();
    };
  }, [cancel]);
  const update = (event: React.PointerEvent<SVGSVGElement>) => {
    event.stopPropagation();
    const pagePoint = eventPagePoint(event);
    setCursor(pagePoint);
    const current = stroke.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (current.value.points.length >= 2048) return;
    const value =
      current.value.space === "page"
        ? pagePoint
        : pagePointToLettering(pagePoint, block, page);
    current.value.points.push(value);
    preview.queue({
      blockPreview: {
        blockId: block.id,
        block: withStroke(block, current.value),
      },
    });
  };
  const start = (event: React.PointerEvent<SVGSVGElement>) => {
    if (
      event.button !== 0 ||
      (block.generatedLettering?.maskStrokes?.length ?? 0) >= 500
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    stroke.current = {
      pointer: event.pointerId,
      value: createLetteringStroke(tool, block, page),
    };
    update(event);
  };
  const end = (event: React.PointerEvent<SVGSVGElement>) => {
    event.stopPropagation();
    if (stroke.current?.pointer !== event.pointerId) return;
    update(event);
    const next = withStroke(block, stroke.current.value);
    cancel();
    controls.onUpdate({ generatedLettering: next.generatedLettering });
  };
  return { cursor, setCursor, stroke, cancel, update, start, end };
}

function eventPagePoint(event: React.PointerEvent<SVGSVGElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(1000, ((event.clientX - rect.left) / rect.width) * 1000),
    ),
    y: Math.max(
      0,
      Math.min(1000, ((event.clientY - rect.top) / rect.height) * 1000),
    ),
  };
}
function createLetteringStroke(
  tool: LetteringTool,
  block: TranslationBlock,
  page: MangaPage,
): LetteringMaskStroke {
  const box = block.renderBbox ?? block.bbox;
  return {
    space: tool.space,
    mode: tool.mode,
    shape: tool.shape,
    softness: tool.softness,
    points: [],
    radiusX: Math.min(
      100000,
      (tool.size / 2 / page.width) *
        1000 *
        (tool.space === "asset" ? 1000 / box.w : 1),
    ),
    radiusY: Math.min(
      100000,
      (tool.size / 2 / page.height) *
        1000 *
        (tool.space === "asset" ? 1000 / box.h : 1),
    ),
  };
}

function withStroke(
  block: TranslationBlock,
  stroke: LetteringMaskStroke,
): TranslationBlock {
  if (!block.generatedLettering) return block;
  return {
    ...block,
    generatedLettering: {
      ...block.generatedLettering,
      maskStrokes: [
        ...(block.generatedLettering?.maskStrokes ?? []),
        { ...stroke, points: [...stroke.points] },
      ],
    },
  };
}
