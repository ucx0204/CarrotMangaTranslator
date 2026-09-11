import type { RedactionRasterRegion } from "../../../../shared/imageRedactionRaster";

export type RedactionMaskWindow = RedactionRasterRegion & { factor: number };
type Size = { width: number; height: number };

/** Align reductions and redraw boundaries so adjacent native tiles cannot drift. */
export function redactionMaskWindow(
  page: Size,
  visible: RedactionRasterRegion,
  zoom: number,
): RedactionMaskWindow {
  const scale = Math.max(0.00001, zoom / 100);
  let factor = 2 ** Math.max(0, Math.floor(Math.log2(1 / scale)));
  factor = Math.min(512, factor);
  const quantum = factor * 64;
  const left = Math.max(0, Math.floor(visible.x / quantum) * quantum - quantum);
  const top = Math.max(0, Math.floor(visible.y / quantum) * quantum - quantum);
  const right = Math.min(
    page.width,
    Math.ceil((visible.x + visible.width) / quantum) * quantum + quantum,
  );
  const bottom = Math.min(
    page.height,
    Math.ceil((visible.y + visible.height) / quantum) * quantum + quantum,
  );
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    factor,
  };
}

export function sameRedactionMaskWindow(
  a: RedactionMaskWindow,
  b: RedactionMaskWindow,
): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.factor === b.factor
  );
}
