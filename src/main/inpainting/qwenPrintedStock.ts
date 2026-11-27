import { soundStencilWindow } from "./qwenRuledPaper";

type Window = NonNullable<ReturnType<typeof soundStencilWindow>>;

function nativeStock(window: Window, bitmap: Buffer, stride: number) {
  const { local, gray, box, distance } = window;
  let selected = 0,
    print = 0,
    bank = 0,
    blank = 0,
    midtone = 0,
    coloured = 0;
  for (let i = 0; i < gray.length; i++) {
    if (local[i]) {
      selected++;
      print += Number(gray[i] < 80);
      continue;
    }
    if (distance[i] < 5 || distance[i] >= 24) continue;
    const x = box.x + (i % box.w),
      y = box.y + Math.floor(i / box.w),
      at = 4 * (y * stride + x);
    if (bitmap[at + 3] !== 255) continue;
    bank++;
    blank += Number(gray[i] > 244);
    midtone += Number(gray[i] > 130 && gray[i] < 230);
    coloured += Number(
      Math.max(bitmap[at], bitmap[at + 1], bitmap[at + 2]) -
        Math.min(bitmap[at], bitmap[at + 1], bitmap[at + 2]) >
        9,
    );
  }
  return {
    printed: print / selected,
    blank: blank / bank,
    midtone: midtone / bank,
    monochrome: bank >= 550 && coloured < 0.012 * bank,
  };
}

/** Separate native pen flecks outside the overprint from the actual type components. */
function stockComponents({ darkComponents, box, distance, local }: Window) {
  const letters = [],
    flecks = [];
  for (const { data, rect, area } of darkComponents(106, 2)) {
    let selected = 0,
      near = 0;
    data.forEach((on, i) => {
      if (!on) return;
      const at =
        (rect.y + Math.floor(i / rect.w)) * box.w + rect.x + (i % rect.w);
      selected += Number(Boolean(local[at]));
      near += Number(distance[at] >= 5 && distance[at] < 24);
    });
    if (selected >= 32 && selected > 0.6 * area) letters.push(rect);
    else if (area <= 32 && near > 0.75 * area) flecks.push(rect);
  }
  return { letters, flecks };
}

export function nativePrintedStock(
  bitmap: Buffer,
  stencil: Uint8Array,
  size: { width: number; height: number },
) {
  const window = soundStencilWindow(
    bitmap,
    stencil,
    size,
    38,
    (box) => box.w >= 38 && box.w <= 210 && box.h >= 68 && box.h <= 335,
  );
  if (!window) return;
  const stock = nativeStock(window, bitmap, size.width);
  if (!stock.monochrome) return;
  if (stock.blank > 0.59 && stock.printed < 0.23 && facetedFrame(window))
    return "facetedFrame" as const;
  const components = stockComponents(window);
  if (paperEdgeCaption(window, components.letters))
    return "paperEdgeCaption" as const;
  if (roughStone(stock, components)) return "roughStone" as const;
  if (drawnCloth(stock, components)) return "drawnCloth" as const;
}

/** A vertical typeset column interrupts a drawn edge between white paper and screened artwork. */
function paperEdgeCaption(
  { active, box, gray }: Window,
  letters: Window["active"][],
) {
  if (active.h < 85 || active.h < 2.2 * active.w || letters.length < 4)
    return false;
  const left = active.x - box.x,
    top = active.y - box.y,
    right = left + active.w;
  if (left < 24 || right + 23 > box.w) return false;
  const square = letters.filter(
    ({ w, h }) => w >= 9 && h >= 12 && w >= 0.68 * h && w <= 1.4 * h,
  );
  if (square.length < 4 || spansTwoPrintColumns(square)) return false;
  const bank = (start: number) => {
    let paper = 0,
      tone = 0,
      pen = 0;
    for (let y = top; y < top + active.h; y++)
      for (let x = start; x < start + 19; x++) {
        const value = gray[y * box.w + x];
        paper += Number(value >= 249);
        tone += Number(value < 241);
        pen += Number(value < 148);
      }
    const count = 19 * active.h;
    return {
      blank: paper > 0.975 * count,
      drawn: tone > 0.35 * count && pen > 0.035 * count,
    };
  };
  const a = bank(left - 24),
    b = bank(right + 4);
  return (a.blank && b.drawn) || (b.blank && a.drawn);
}

function roughStone(
  stock: ReturnType<typeof nativeStock>,
  { letters, flecks }: ReturnType<typeof stockComponents>,
) {
  return (
    stock.printed > 0.7 &&
    stock.blank > 0.62 &&
    stock.midtone > 0.035 &&
    stock.midtone < 0.25 &&
    letters.length >= 2 &&
    letters.length <= 9 &&
    flecks.length >= 10 &&
    flecks.filter((rect) => rect.h > 1.2 * rect.w).length >= 4
  );
}

function drawnCloth(
  stock: ReturnType<typeof nativeStock>,
  { letters, flecks }: ReturnType<typeof stockComponents>,
) {
  const square = letters.filter(
    (rect) =>
      Math.min(rect.w, rect.h) >= 9 &&
      Math.max(rect.w, rect.h) <= 1.52 * Math.min(rect.w, rect.h),
  );

  return (
    stock.printed > 0.34 &&
    stock.printed < 0.64 &&
    stock.midtone > 0.2 &&
    stock.blank > 0.25 &&
    stock.blank < 0.7 &&
    letters.length >= 10 &&
    square.length >= 7 &&
    flecks.length < 0.4 * letters.length &&
    spansTwoPrintColumns(square)
  );
}

function spansTwoPrintColumns(letters: Window["active"][]) {
  const width =
    letters.reduce((sum, letter) => sum + letter.w, 0) / letters.length;
  const centers = letters.map((letter) => letter.x + letter.w / 2);
  const columns = centers.filter(
    (center) =>
      centers.filter((x) => Math.abs(x - center) < 0.4 * width).length >= 3,
  );
  return Math.max(...columns) - Math.min(...columns) > 1.3 * width;
}

/** Enclosed light letters are crossed by two independently visible sides of the frame. */
function facetedFrame(window: Window) {
  const { gray, box, active, local } = window;
  if (active.h < 1.45 * active.w) return false;
  const faces = window
    .lightComponents(168, 60)
    .filter(({ rect, data, area }) => {
      if (area > 6500 || Math.max(rect.w, rect.h) > 150) return false;
      let owned = 0,
        light = 0;
      data.forEach((value, i) => {
        if (!value) return;
        const at =
          (rect.y + Math.floor(i / rect.w)) * box.w + rect.x + (i % rect.w);
        owned += Number(Boolean(local[at]));
        light += Number(gray[at] > 232);
      });
      return owned > 0.87 * area && light > 0.72 * area;
    });
  return (
    faces.length >= 7 &&
    hasFrameSide(window, false) &&
    hasFrameSide(window, true)
  );
}
function hasFrameSide(window: Window, right: boolean) {
  const { active, box } = window;
  const left = active.x - box.x,
    top = active.y - box.y;
  const from = right ? left + 0.68 * active.w : left - 37,
    to = right ? left + active.w + 37 : left + 0.33 * active.w;
  const first = top + Math.floor(0.38 * active.h),
    last = top + Math.floor(0.85 * active.h);
  for (let angle = -13; angle <= 13; angle++)
    for (let start = Math.ceil(from); start <= to; start++)
      if (
        supportedRule(
          window,
          first,
          last,
          start,
          top + 0.55 * active.h,
          angle / 20,
        )
      )
        return true;
  return false;
}

function supportedRule(
  { gray, distance, box }: Window,
  first: number,
  last: number,
  start: number,
  center: number,
  slope: number,
) {
  let hits = 0;
  for (let y = first; y < last; y += 2) {
    const x = Math.round(start + (y - center) * slope);
    if (x < 4 || x >= box.w - 4) continue;
    const at = y * box.w + x;
    if (
      distance[at] > 3 &&
      Math.min(gray[at - 1], gray[at], gray[at + 1]) < 140 &&
      Math.max(gray[at - 3], gray[at + 3]) > 220
    )
      hits++;
  }
  return hits > 0.6 * Math.ceil((last - first) / 2);
}
