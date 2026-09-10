import React from "react";
import type { RedactionView, RedactionWorkspacePage } from "../../../../shared/imageRedactionWorkspace";
import { useWorkspaceWheelZoom } from "../../hooks/useWorkspaceWheelZoom";
import { useEventCallback } from "../../hooks/useEventCallback";
import { useContainedPageSize } from "../useContainedPageSize";

type PageView = RedactionView["pageViews"][string];
export function useRedactionViewport(page: RedactionWorkspacePage, view: PageView | undefined, onView: (view: PageView) => void, disabled: boolean) {
  const viewport = React.useRef<HTMLDivElement>(null);
  const stage = React.useRef<HTMLDivElement>(null);
  const fit = useContainedPageSize(viewport, page);
  const zoom = view?.zoom || fit.width * 100 / page.width;
  const anchor = React.useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const update = useEventCallback(onView);
  const currentView = useEventCallback(() => view ?? { zoom: 0, x: 0, y: 0 });
  useWorkspaceWheelZoom({
    workspacePanelRef: viewport,
    fitHeight: () => { if (!disabled) update({ ...currentView(), zoom: 0 }); },
    zoom: (gesture) => {
      if (disabled || !stage.current) return;
      const rect = stage.current.getBoundingClientRect();
      anchor.current = { x: (gesture.clientX - rect.left) / rect.width, y: (gesture.clientY - rect.top) / rect.height, clientX: gesture.clientX, clientY: gesture.clientY };
      update({ ...currentView(), zoom: Math.max(1, Math.min(800, zoom * Math.exp((gesture.direction === "in" ? 1 : -1) * Math.min(240, gesture.deltaPixels) * 0.002))) });
    },
  });
  React.useLayoutEffect(() => {
    const target = viewport.current, image = stage.current;
    if (!target || !image) return;
    const point = anchor.current;
    if (point) {
      const rect = image.getBoundingClientRect();
      target.scrollLeft += rect.left + point.x * rect.width - point.clientX;
      target.scrollTop += rect.top + point.y * rect.height - point.clientY;
      anchor.current = null;
    } else {
      const saved = currentView();
      target.scrollLeft = saved.x * Math.max(0, target.scrollWidth - target.clientWidth);
      target.scrollTop = saved.y * Math.max(0, target.scrollHeight - target.clientHeight);
    }
  }, [page.id, zoom, currentView]);
  const onScroll = () => {
    const target = viewport.current;
    if (!target) return;
    update({ ...currentView(), x: target.scrollLeft / Math.max(1, target.scrollWidth - target.clientWidth), y: target.scrollTop / Math.max(1, target.scrollHeight - target.clientHeight) });
  };
  return { viewport, stage, zoom, onScroll };
}
