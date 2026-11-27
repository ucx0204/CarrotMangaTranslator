import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import { nativeLuminance } from "./qwenOutlinedLettering";

type MeasuredCaption = InpaintingWindowMask & {
  level: number;
  levels?: Uint8Array;
};

type Rule = { y: number; edge: Uint8Array };

/** Verify the two exposed edges of a printed strip. On each side the flat
 * stock must end and the underlying illustration must become visible. */
export function findCaptionBand(
  tone: Uint8Array,
  stride: number,
  rect: PixelRect,
): { start: number; end: number } | undefined {
  const rows = Array.from({ length: tone.length / stride }, (_, y) => {
    const row = tone
      .slice(y * stride + rect.x, y * stride + rect.x + rect.w)
      .sort();
    return {
      dark: row[Math.round((row.length - 1) * 0.35)] < 34,
      flat: row[Math.round((row.length - 1) * 0.91)] < 29,
      exterior: row[Math.round((row.length - 1) * 0.78)],
    };
  });
  const inner = opaqueRows(rows, rect);
  if (!inner) return;
  const { start, end } = inner;
  const thickness = end - start + 1;
  const exterior = (a: number, b: number) =>
    rows.slice(a, b).some((row) => row.exterior >= 72);
  if (
    thickness < 0.78 * rect.h ||
    thickness > 2.55 * rect.h ||
    !rows.slice(start, end + 1).every((row) => row.dark) ||
    !exterior(Math.max(0, start - 4), start) ||
    !exterior(end + 1, end + 5)
  )
    return;
  return { start, end: end + 1 };
}

function opaqueRows(rows: { flat: boolean }[], rect: PixelRect) {
  let start = Math.min(rows.length - 1, rect.y + 1);
  let end = Math.max(0, rect.y + rect.h - 2);
  while (start >= 0 && !rows[start].flat) start--;
  while (end < rows.length && !rows[end].flat) end++;
  if (start < 0 || end >= rows.length) return;
  while (start > 0 && rows[start - 1].flat) start--;
  while (end + 1 < rows.length && rows[end + 1].flat) end++;
  return { start, end };
}

export function publisherRibbonBacking(
  gray: Uint8Array,
  bounds: PixelRect,
  text: PixelRect,
  band: { start: number; end: number },
) {
  const thickness = band.end - band.start;
  const extension = Math.ceil(2.1 * thickness);
  const data = new Uint8Array(gray.length);
  const left = Math.max(0, text.x - extension);
  const right = Math.min(bounds.w, text.x + text.w + extension);
  for (
    let y = Math.max(0, band.start - 2);
    y < Math.min(bounds.h, band.end + 2);
    y++
  ) {
    for (let x = left; x < right; x++) {
      const i = y * bounds.w + x;
      if ((x >= text.x && x < text.x + text.w) || gray[i] < 180) data[i] = 1;
    }
  }
  return { bounds, data };
}

/** The model may continue the drawing behind an opaque print strip. Verify
 * that its lettering has disappeared in every part before restoring the
 * independently measured stock across that drawing. */
function erasedSubtitleContrast(
  source: Buffer,
  decoded: Buffer,
  stride: number,
  band: MeasuredCaption,
) {
  const { bounds, data, level } = band;
  if (band.levels || bounds.h < 7 || bounds.h > 75 || bounds.w < 5 * bounds.h)
    return false;
  let left = bounds.w,
    right = -1;
  data.forEach((on, i) => {
    if (on) {
      left = Math.min(left, i % bounds.w);
      right = Math.max(right, i % bounds.w);
    }
  });
  if (right - left < 74) return false;
  const sections = Array.from({ length: 8 }, () => [] as number[]);
  data.forEach((on, i) => {
    if (!on) return;
    const x = i % bounds.w,
      y = Math.floor(i / bounds.w);
    const center = 4 * ((bounds.y + y) * stride + bounds.x + x) + 1;
    if (Math.abs(source[center] - level) <= 115) return;
    const bank: number[] = [];
    for (let dy = Math.max(-3, -y); dy <= Math.min(3, bounds.h - 1 - y); dy++)
      for (
        let dx = Math.max(-3, -x);
        dx <= Math.min(3, bounds.w - 1 - x);
        dx++
      ) {
        const p = center + 4 * (dy * stride + dx);
        if (Math.abs(source[p] - level) < 10) bank.push(decoded[p]);
      }
    if (bank.length < 3) return;
    bank.sort((a, b) => a - b);
    const background =
      (bank[Math.floor((bank.length - 1) / 2)] +
        bank[Math.floor(bank.length / 2)]) /
      2;
    sections[Math.floor((8 * (x - left)) / (right - left + 1))].push(
      Math.abs(decoded[center] - background),
    );
  });
  return sections.every((samples) => {
    if (samples.length < 12) return false;
    samples.sort((a, b) => a - b);
    return (
      samples[Math.floor(samples.length / 2)] < 17 &&
      samples[Math.floor(0.65 * samples.length)] < 28
    );
  });
}

/** A publisher may put a tiny subtitle between two ruled lines in a title.
 * Both lines, intervening glyph contrast, and detected title rows on both
 * sides must agree in the original crop before treating the gap as print. */
export function measuredQwenSubtitle(
  bitmap: Buffer,
  stride: number,
  rect: PixelRect,
  instance: InpaintingWindowMask,
): InpaintingWindowMask | undefined {
  const { w, h } = rect;
  if (w < 46 || h < 30 || w * h > 120000) return;
  const tone = nativeLuminance(bitmap, stride, rect),
    ink = projectWindowMask(instance, rect);
  const data = new Uint8Array(ink.length);
  for (const sign of [1, -1]) {
    const rules = findRules(tone, ink, w, h, sign);
    for (const upper of rules)
      for (const lower of rules)
        addSubtitlesBetweenRules(data, tone, ink, w, h, upper, lower);
  }
  if (data.some(Boolean)) return { bounds: rect, data };
}

function findRules(
  tone: Uint8Array,
  ink: Uint8Array,
  w: number,
  h: number,
  sign: number,
) {
  const rules: Rule[] = [];
  for (let y = 3; y < h - 3; y++) {
    const edge = new Uint8Array(w);
    let marked = 0,
      points = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        center = sign * tone[i];
      const top = center - Math.min(sign * tone[i - w], sign * tone[i - 2 * w]);
      const bottom =
        center - Math.min(sign * tone[i + w], sign * tone[i + 2 * w]);
      edge[x] = Number(Math.min(top, bottom) > 15);
      points += edge[x];
      marked += Number(!!ink[i]);
    }
    if (points > 0.35 * w && marked < 0.48 * w) rules.push({ y, edge });
  }
  return rules;
}

function supportedSpan(edge: Uint8Array, x: number) {
  return edge.subarray(Math.max(0, x - 2), x + 3).some(Boolean);
}

function matchRuleAt(upper: Rule, lower: Rule, x: number) {
  return (
    (upper.edge[x] && supportedSpan(lower.edge, x)) ||
    (lower.edge[x] && supportedSpan(upper.edge, x))
  );
}

function addSubtitlesBetweenRules(
  data: Uint8Array,
  tone: Uint8Array,
  ink: Uint8Array,
  w: number,
  h: number,
  upper: Rule,
  lower: Rule,
) {
  const height = lower.y - upper.y;
  if (height < 4 || height > Math.min(17, 0.23 * h)) return;
  let left = -1,
    last = -1;
  for (let x = 0; x <= w; x++) {
    const both = matchRuleAt(upper, lower, x);
    if (both) {
      if (left < 0) left = x;
      last = x;
    }
    if (left < 0 || (x < w && x - last <= 8)) continue;
    const end = last + 1;
    if (
      end - left >= Math.max(43, 0.49 * w) &&
      supportsSmallType(tone, ink, w, h, left, end, upper, lower)
    ) {
      for (let y = upper.y - 2; y <= lower.y + 2; y++)
        data.fill(
          1,
          y * w + Math.max(0, left - 3),
          y * w + Math.min(w, end + 3),
        );
    }
    left = -1;
  }
}

function supportsSmallType(
  tone: Uint8Array,
  ink: Uint8Array,
  w: number,
  h: number,
  left: number,
  end: number,
  upper: Rule,
  lower: Rule,
) {
  const sum = (row: Uint8Array) =>
    row.subarray(left, end).reduce((a, b) => a + b, 0);
  if (Math.min(sum(upper.edge), sum(lower.edge)) < 0.57 * (end - left))
    return false;
  const contrast = (y: number) => {
    let change = 0;
    for (let x = left + 1; x < end; x++)
      change += Math.abs(tone[y * w + x] - tone[y * w + x - 1]);
    return change / (end - left - 1);
  };
  let letters = 0;
  for (let y = upper.y + 1; y < lower.y; y++)
    letters = Math.max(letters, contrast(y));
  if (
    letters <
    Math.max(13, 1.72 * Math.max(contrast(upper.y), contrast(lower.y)))
  )
    return false;
  const hasTitleRow = (start: number, stop: number) => {
    for (let y = Math.max(0, start); y < Math.min(stop, h); y++)
      if (sum(ink.subarray(y * w, (y + 1) * w)) > 0.33 * (end - left))
        return true;
    return false;
  };
  return (
    hasTitleRow(upper.y - 23, upper.y - 2) &&
    hasTitleRow(lower.y + 3, lower.y + 25)
  );
}

export function verifyDecodedCaption(
  source: Buffer,
  prediction: Buffer,
  width: number,
  caption: MeasuredCaption,
) {
  const { bounds, level } = caption,
    pixels: [number, number][] = [];
  let agree = 0,
    originalInk = 0,
    erasedInk = 0;
  caption.data.forEach((on, i) => {
    if (!on) return;
    const p =
      4 *
      ((bounds.y + Math.floor(i / bounds.w)) * width +
        bounds.x +
        (i % bounds.w));
    pixels.push([i, p]);
    const matches = [0, 1, 2].every(
      (c) => Math.abs(prediction[p + c] - level) <= 25,
    );
    agree += Number(matches);
    if (Math.abs(source[p + 1] - level) > 90) {
      originalInk++;
      erasedInk += Number(matches);
    }
  });
  const restorePlate =
    agree < 0.68 * pixels.length ||
    (!caption.levels && erasedInk < 0.68 * originalInk);
  if (
    restorePlate &&
    (agree < 0.22 * pixels.length ||
      !erasedSubtitleContrast(source, prediction, width, caption))
  )
    return;
  return { pixels, restorePlate };
}
