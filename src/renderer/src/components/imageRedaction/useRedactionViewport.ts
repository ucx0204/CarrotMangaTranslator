import React from "react";
import type {
  RedactionView,
  RedactionWorkspacePage,
} from "../../../../shared/imageRedactionWorkspace";
import { useWorkspaceWheelZoom } from "../../hooks/useWorkspaceWheelZoom";
import { useEventCallback } from "../../hooks/useEventCallback";
import { useContainedPageSize } from "../useContainedPageSize";

type PageView = RedactionView["pageViews"][string];
export function useRedactionViewport(
  page: RedactionWorkspacePage,
  view: PageView | undefined,
  onView: (view: PageView) => void,
  disabled: boolean,
) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const fit = useContainedPageSize(viewportRef, page);
  const zoom = view?.zoom || (fit.width * 100) / page.width;
  const anchor = React.useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const update = useEventCallback(onView);
  const currentView = useEventCallback(() => view ?? { zoom: 0, x: 0, y: 0 });
  useWorkspaceWheelZoom({
    workspacePanelRef: viewportRef,
    fitHeight: () => {
      if (!disabled) update({ ...currentView(), zoom: 0 });
    },
    zoom: (gesture) => {
      if (disabled || !stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();
      anchor.current = {
        x: (gesture.clientX - rect.left) / rect.width,
        y: (gesture.clientY - rect.top) / rect.height,
        clientX: gesture.clientX,
        clientY: gesture.clientY,
      };
      update({
        ...currentView(),
        zoom: resolveZoom(zoom, gesture.direction, gesture.deltaPixels),
      });
    },
  });
  React.useLayoutEffect(() => {
    const target = viewportRef.current,
      image = stageRef.current;
    if (!target || !image) return;
    const point = anchor.current;
    if (point) {
      const rect = image.getBoundingClientRect();
      target.scrollLeft += rect.left + point.x * rect.width - point.clientX;
      target.scrollTop += rect.top + point.y * rect.height - point.clientY;
      anchor.current = null;
    } else {
      const saved = currentView();
      target.scrollLeft =
        saved.x * Math.max(0, target.scrollWidth - target.clientWidth);
      target.scrollTop =
        saved.y * Math.max(0, target.scrollHeight - target.clientHeight);
    }
  }, [page.id, zoom, currentView]);
  const onScroll = () => {
    const target = viewportRef.current;
    if (!target) return;
    update({
      ...currentView(),
      x:
        target.scrollLeft /
        Math.max(1, target.scrollWidth - target.clientWidth),
      y:
        target.scrollTop /
        Math.max(1, target.scrollHeight - target.clientHeight),
    });
  };
  return { viewportRef, stageRef, zoom, onScroll };
}

function resolveZoom(
  zoom: number,
  direction: "in" | "out",
  deltaPixels: number,
): number {
  return Math.max(
    1,
    Math.min(
      800,
      zoom *
        Math.exp(
          (direction === "in" ? 1 : -1) * Math.min(240, deltaPixels) * 0.002,
        ),
    ),
  );
}
