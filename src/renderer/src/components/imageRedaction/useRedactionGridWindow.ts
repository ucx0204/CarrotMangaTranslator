import React from "react";
import { useEventCallback } from "../../hooks/useEventCallback";

export function useRedactionGridWindow(
  count: number,
  size: number,
  compact: boolean,
  initialOffset: number,
  onOffset: (value: number) => void,
) {
  const viewport = React.useRef<HTMLDivElement>(null);
  const [measure, setMeasure] = React.useState({
    width: 600,
    height: 500,
    top: initialOffset,
  });
  const notify = useEventCallback(onOffset);
  const rowHeight = size + 66;
  const columns = compact
    ? 1
    : Math.max(1, Math.floor(measure.width / (size + 20)));
  const rows = Math.ceil(count / columns);
  const firstRow = Math.max(0, Math.floor(measure.top / rowHeight) - 1);
  const lastRow = Math.min(
    rows,
    Math.ceil((measure.top + measure.height) / rowHeight) + 1,
  );
  React.useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = initialOffset;
    const update = () =>
      setMeasure({
        width: element.clientWidth,
        height: element.clientHeight,
        top: element.scrollTop,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
    // The saved offset is applied on entry, not on every scroll notification.
  }, []);
  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    setMeasure({
      width: element.clientWidth,
      height: element.clientHeight,
      top: element.scrollTop,
    });
    notify(element.scrollTop);
  };
  const reveal = (index: number) => {
    const element = viewport.current;
    if (!element || index < 0) return;
    const top = Math.floor(index / columns) * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
    setMeasure({
      width: element.clientWidth,
      height: element.clientHeight,
      top: element.scrollTop,
    });
  };
  return {
    viewport,
    columns,
    rowHeight,
    start: firstRow * columns,
    end: lastRow * columns,
    top: firstRow * rowHeight,
    totalHeight: rows * rowHeight,
    onScroll,
    reveal,
  };
}
