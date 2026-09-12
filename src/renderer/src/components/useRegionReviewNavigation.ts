import React from "react";
import { isEditableTarget } from "../lib/appHelpers";
import { useWorkspaceWheelZoom } from "../hooks/useWorkspaceWheelZoom";
import type { RegionReviewTool } from "./useRegionReviewDrawing";
import type { useRegionReviewForm } from "./useRegionReviewForm";

export function useRegionReviewListFocus(focused: string | undefined) {
  const fields = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    fields.current
      ?.querySelector<HTMLElement>("[data-selected]")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [focused]);
  return fields;
}

type Options = {
  viewport: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  setZoom: (value: number) => void;
  tool: RegionReviewTool;
  setTool: (value: RegionReviewTool) => void;
  setSize: React.Dispatch<React.SetStateAction<number>>;
  disabled: boolean;
  form: ReturnType<typeof useRegionReviewForm>;
};
export function useRegionReviewNavigation(options: Options) {
  const { tool } = options;
  const [panning, setPanning] = React.useState(false);
  useReviewZoom(options);
  React.useEffect(() => {
    const release = () => setPanning(false);
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);
  return {
    tool: panning ? ("pan" as const) : tool,
    handlers: {
      onKeyDown: (event: React.KeyboardEvent) =>
        handleReviewKey(event, options, setPanning),
      onKeyUp: (event: React.KeyboardEvent) => {
        if (event.key === " ") setPanning(false);
      },
      onBlur: (event: React.FocusEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPanning(false);
      },
    },
  };
}

function useReviewZoom({ viewport, zoom, setZoom }: Options) {
  const anchor = React.useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  useWorkspaceWheelZoom({
    workspacePanelRef: viewport,
    fitHeight: () => setZoom(0),
    zoom: (gesture) => {
      const stage = viewport.current?.querySelector<HTMLElement>(
        "[data-region-review-stage]",
      );
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      anchor.current = {
        x: (gesture.clientX - rect.left) / rect.width,
        y: (gesture.clientY - rect.top) / rect.height,
        clientX: gesture.clientX,
        clientY: gesture.clientY,
      };
      setZoom(
        Math.max(
          1,
          Math.min(
            800,
            zoom *
              Math.exp(
                (gesture.direction === "in" ? 1 : -1) *
                  Math.min(240, gesture.deltaPixels) *
                  0.002,
              ),
          ),
        ),
      );
    },
  });
  React.useLayoutEffect(() => {
    const stage = viewport.current?.querySelector<HTMLElement>(
      "[data-region-review-stage]",
    );
    const point = anchor.current;
    if (!stage || !viewport.current || !point) return;
    const rect = stage.getBoundingClientRect();
    viewport.current.scrollLeft +=
      rect.left + point.x * rect.width - point.clientX;
    viewport.current.scrollTop +=
      rect.top + point.y * rect.height - point.clientY;
    anchor.current = null;
  }, [zoom, viewport]);
}

function handleReviewKey(
  event: React.KeyboardEvent,
  options: Options,
  setPanning: (value: boolean) => void,
) {
  if (
    options.disabled ||
    event.nativeEvent.isComposing ||
    isEditableTarget(event.target)
  )
    return;
  const action = reviewKeyAction(event, options, setPanning);
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  action();
}
function reviewKeyAction(
  event: React.KeyboardEvent,
  options: Options,
  setPanning: (value: boolean) => void,
): (() => void) | undefined {
  const key = event.key.toLowerCase();
  if (event.altKey) return;
  if (event.ctrlKey || event.metaKey) {
    if (key === "y") return options.form.redo;
    if (key === "z")
      return event.shiftKey ? options.form.redo : options.form.undo;
    return;
  }
  return plainKeyAction(
    key,
    event.target === options.viewport.current,
    options,
    setPanning,
  );
}
function plainKeyAction(
  key: string,
  canvasFocused: boolean,
  options: Options,
  setPanning: (value: boolean) => void,
): (() => void) | undefined {
  const tools: Record<string, RegionReviewTool> = {
    v: "bounds",
    r: "add",
    p: "paint",
    b: "hide",
    e: "restore",
    h: "pan",
  };
  if (tools[key]) return () => options.setTool(tools[key]);
  if (key === "delete" || key === "backspace") return options.form.removeRegion;
  if (key === "[" || key === "]")
    return () =>
      options.setSize((value) =>
        Math.max(1, Math.min(400, value + (key === "[" ? -4 : 4))),
      );
  if (key === " " && canvasFocused) return () => setPanning(true);
}
