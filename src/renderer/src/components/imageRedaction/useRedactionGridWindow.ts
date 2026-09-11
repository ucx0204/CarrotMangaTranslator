import React from "react";
import { useEventCallback } from "../../hooks/useEventCallback";

/** Virtualized single-column filmstrip; stored offsets remain draft-compatible. */
export function useRedactionGridWindow(
  count: number,
  rowHeight: number,
  savedOffset: number,
  onOffset: (offset: number) => void,
) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [measure, setMeasure] = React.useState({
    height: 500,
    top: savedOffset,
  });
  const notify = useEventCallback(onOffset);
  const measureViewport = useEventCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    const next = { height: element.clientHeight, top: element.scrollTop };
    setMeasure((current) =>
      current.height === next.height && current.top === next.top
        ? current
        : next,
    );
  });
  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    measureViewport();
    const observer = new ResizeObserver(measureViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measureViewport]);
  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    element.scrollTop = Math.min(
      savedOffset,
      Math.max(0, count * rowHeight - element.clientHeight),
    );
    measureViewport();
  }, [savedOffset, count, rowHeight, measureViewport]);
  const reveal = useEventCallback((index: number) => {
    const element = viewportRef.current;
    if (!element || index < 0) return;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
    measureViewport();
  });
  const start = Math.max(
    0,
    Math.min(count - 1, Math.floor(measure.top / rowHeight) - 1),
  );
  const end = Math.min(
    count,
    Math.ceil((measure.top + measure.height) / rowHeight) + 1,
  );
  const onScroll = () => {
    measureViewport();
    if (viewportRef.current) notify(viewportRef.current.scrollTop);
  };
  return {
    viewportRef,
    start,
    end,
    top: start * rowHeight,
    totalHeight: count * rowHeight,
    onScroll,
    reveal,
  };
}
