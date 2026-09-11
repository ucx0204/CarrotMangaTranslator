import React from "react";
import {
  redactionMaskWindow,
  sameRedactionMaskWindow,
} from "./redactionMaskWindow";

/** Measure the already-positioned stage; zoom anchoring remains owned by the viewport. */
export function useRedactionMaskWindow(
  viewport: React.RefObject<HTMLDivElement | null>,
  stage: React.RefObject<HTMLDivElement | null>,
  page: { width: number; height: number },
  zoom: number,
) {
  const { width, height } = page;
  const [window, setWindow] = React.useState(() =>
    redactionMaskWindow(page, { x: 0, y: 0, width: 1, height: 1 }, zoom),
  );
  React.useLayoutEffect(() => {
    const element = viewport.current;
    const image = stage.current;
    if (!element || !image) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const container = element.getBoundingClientRect();
      const bounds = image.getBoundingClientRect();
      const scale = Math.max(0.00001, zoom / 100);
      const x = Math.min(
        width - 1,
        Math.max(0, (container.left - bounds.left) / scale),
      );
      const y = Math.min(
        height - 1,
        Math.max(0, (container.top - bounds.top) / scale),
      );
      const next = redactionMaskWindow(
        { width, height },
        {
          x,
          y,
          width: Math.min(width - x, Math.max(1, element.clientWidth) / scale),
          height: Math.min(
            height - y,
            Math.max(1, element.clientHeight) / scale,
          ),
        },
        zoom,
      );
      setWindow((previous) =>
        sameRedactionMaskWindow(previous, next) ? previous : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [viewport, stage, width, height, zoom]);
  return window;
}
