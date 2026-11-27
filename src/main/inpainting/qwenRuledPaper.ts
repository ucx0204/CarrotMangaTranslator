import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { TranslationBlock } from "../../shared/textTypes";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { maskBoundsInRect } from "./imageRaster";
import { maskComponents } from "./rasterMasks";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { distanceToMask } from "./pageMaskComposite";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import { median } from "./qwenSoundRim";

type Size = { width: number; height: number };
export function soundStencilWindow(
  source: Buffer,
  stencil: Uint8Array,
  size: Size,
  pad: number,
  accepts: (ink: PixelRect) => boolean,
) {
  const page = { x: 0, y: 0, w: size.width, h: size.height };
  const active = maskBoundsInRect(stencil, size.width, page);
  if (!active || !accepts(active)) return;
  const box = expandRect(active, size.width, size.height, pad);
  const gray = nativeLuminance(source, size.width, box);
  const local = projectWindowMask({ bounds: page, data: stencil }, box);
  const distance = distanceToMask(local, box.w, box.h);
  return {
    active,
    box,
    gray,
    local,
    distance,
    darkComponents: (level: number, minimumArea: number) =>
      maskComponents(
        gray.map((value) => Number(value < level)),
        box.w,
        box.h,
        minimumArea,
      ),
    lightComponents: (level: number, minimumArea: number) =>
      maskComponents(
        gray.map((value) => Number(value > level)),
        box.w,
        box.h,
        minimumArea,
      ),
    expanded: (radius: number) =>
      Uint8Array.from(
        distanceToMask(stencil, size.width, size.height),
        (value) => Number(value <= radius),
      ),
  };
}

const verticalKana = /^[\p{Script=Katakana}ー]{2,5}$/u;

/** A fan of bold reaction marks can cross the panel rule and knock holes out
 * of the shaded panel below it. Recover the paper and rule before the edit. */
function ruledAccentCondition(
  source: Buffer,
  stencil: Uint8Array,
  size: { width: number; height: number },
) {
  const window = soundStencilWindow(
    source,
    stencil,
    size,
    18,
    (ink) =>
      ink.h >= 15 && ink.h <= 92 && ink.w >= 1.65 * ink.h && ink.w <= 340,
  );
  if (!window) return;
  const { active: ink, box, gray, local: selected, distance } = window;
  const parts = window.darkComponents(92, 25);
  const marks = parts.filter(({ rect: { x, y, w, h }, area, data }) => {
    if (h < 12 || w > h || area < 0.42 * w * h || area < 3.8 * h) return false;
    let owned = 0;
    data.forEach((on, i) => {
      if (on)
        owned += Number(
          Boolean(selected[(y + Math.floor(i / w)) * box.w + x + (i % w)]),
        );
    });
    return owned >= 0.83 * area;
  });
  if (marks.length < 3 || marks.length > 6) return;
  const heights = marks.map(({ rect }) => rect.h);
  const tops = marks.map(({ rect }) => rect.y);
  const height = Math.max(...heights);
  if (
    Math.min(...heights) < 0.57 * height ||
    Math.max(...tops) - Math.min(...tops) > 0.48 * height
  )
    return;
  const left = ink.x - box.x,
    right = left + ink.w;
  for (
    let y = Math.max(4, Math.min(...tops));
    y <= Math.min(box.h - 5, Math.min(...tops) + 0.58 * height);
    y++
  ) {
    if (isPrintedRuleRow(gray, distance, box, left, right, y))
      return {
        radius: Math.min(10, Math.max(5, Math.round(height * 0.25))),
        row: box.y + y,
        view: expandRect(
          ink,
          size.width,
          size.height,
          Math.min(
            220,
            Math.max(64, Math.floor(0.66 * (Math.max(ink.w, ink.h) - 1))),
          ),
        ),
      };
  }
}

export function pairedRuleEdit(
  source: Buffer,
  stencil: Uint8Array,
  size: Size,
  originalMask: string,
) {
  const rule = ruledAccentCondition(source, stencil, size);
  if (!rule) return;
  return {
    pairedWindow: {
      ...rule.view,
      radius: rule.radius,
      mask: originalMask,
    },
    material: {
      kind: "crossed-rule" as const,
      row: rule.row,
      radius: rule.radius,
    },
    printDescription:
      "Repair the erased part of the first manga crop. The second reference shows its unedited illustration with printed onomatopoeia. Use the original edges outside the erasure as exact guides. Continue any interrupted contours through the gap with the original stroke width and tangent. Match the original paper, tone, shadow and print texture. Preserve decorative frames and objects. Leave the restored area completely free of lettering, glyphs, punctuation and replacement symbols.",
  };
}

function isPrintedRuleRow(
  gray: Uint8Array,
  distance: Float32Array,
  box: PixelRect,
  left: number,
  right: number,
  y: number,
) {
  let whiteAbove = 0,
    darkRule = 0,
    bank = 0,
    textured = 0;
  for (let x = Math.max(0, left - 10); x < Math.min(box.w, right + 10); x++) {
    const i = y * box.w + x;
    if (distance[i] < 5 || distance[i - 3 * box.w] < 4) continue;
    bank++;
    whiteAbove += Number(gray[i - 3 * box.w] >= 237);
    darkRule += Number(gray[i] < 95);
    textured += Number(gray[i + 4 * box.w] > 110 && gray[i + 4 * box.w] < 243);
  }
  return (
    bank >= 18 &&
    whiteAbove > 0.88 * bank &&
    darkRule > 0.83 * bank &&
    textured >= 4
  );
}

function originalColumns(gray: Uint8Array, mask: InpaintingWindowMask) {
  const { w, h } = mask.bounds;
  const toInk = distanceToMask(mask.data, w, h);
  const levels = new Float32Array(w);
  let tested = 0,
    consistent = 0;
  for (let x = 0; x < w; x++) {
    const samples: number[] = [],
      held: number[] = [];
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (toInk[i] <= 3) continue;
      if (Math.floor(y / 4) % 3 !== 1) samples.push(gray[i]);
      else if (toInk[i] < 14) held.push(gray[i]);
    }
    if (samples.length < 12) return;
    levels[x] = median(samples);
    for (const v of held) {
      tested++;
      consistent += Number(Math.abs(v - levels[x]) <= 20);
    }
  }
  if (tested >= 95 && consistent >= 0.966 * tested) return levels;
}

function ruledStock(
  source: Buffer,
  size: Size,
  mask: InpaintingWindowMask,
  active: PixelRect,
) {
  const bounds = expandRect(active, size.width, size.height, 26);
  const local = { bounds, data: projectWindowMask(mask, bounds) };
  const gray = nativeLuminance(source, size.width, bounds);
  const levels = originalColumns(gray, local);
  if (!levels) return;
  const pen = singleRuledColumn(levels, active.x - bounds.x, active.w);
  if (pen === undefined || !neutralPaper(source, size.width, local)) return;
  if (hasBlankShoulders(gray, local, pen)) return { local, levels };
}

function neutralPaper(
  source: Buffer,
  stride: number,
  local: InpaintingWindowMask,
) {
  return local.data.every((v, i) => {
    if (!v) return true;
    const p =
      4 *
      ((local.bounds.y + Math.floor(i / local.bounds.w)) * stride +
        local.bounds.x +
        (i % local.bounds.w));
    return (
      source[p + 3] === 255 &&
      Math.max(source[p], source[p + 1], source[p + 2]) -
        Math.min(source[p], source[p + 1], source[p + 2]) <=
        4
    );
  });
}

function singleRuledColumn(levels: Float32Array, left: number, width: number) {
  const lines: number[] = [];
  const right = left + width;
  if (left < 3 || right + 3 > levels.length) return;
  for (let x = left; x < right; x++) if (levels[x] < 233) lines.push(x);
  if (
    !lines.length ||
    lines.length > 3 ||
    lines[lines.length - 1] - lines[0] >= 3
  )
    return;
  const pen = lines.reduce((a, b) => (levels[a] < levels[b] ? a : b));
  if (levels[pen] > 182 || levels[pen - 3] < 247 || levels[pen + 3] < 247)
    return;
  return pen;
}

function hasBlankShoulders(
  gray: Uint8Array,
  local: InpaintingWindowMask,
  pen: number,
) {
  const { bounds } = local;
  const distance = distanceToMask(local.data, bounds.w, bounds.h);
  let near = 0,
    white = 0,
    crossed = 0;
  for (let i = 0; i < gray.length; i++) {
    const x = i % bounds.w;
    if (local.data[i] && x === pen && gray[i] < 145) crossed++;
    if (distance[i] <= 2 || distance[i] > 7 || Math.abs(x - pen) <= 2) continue;
    near++;
    white += Number(gray[i] >= 242);
  }
  return crossed >= 3 && near > 100 && white > 0.972 * near;
}

function supportedStrokes(
  gray: Uint8Array,
  bounds: PixelRect,
  rect: PixelRect,
  instance: InpaintingWindowMask,
) {
  const selected = projectWindowMask(instance, bounds);
  return maskComponents(
    gray.map((v) => Number(v < 144)),
    bounds.w,
    bounds.h,
    22,
  ).filter((p) => {
    const { x, y, w, h } = p.rect;
    if (
      x + bounds.x < rect.x ||
      y + bounds.y < rect.y ||
      x + w + bounds.x > rect.x + rect.w ||
      y + h + bounds.y > rect.y + rect.h
    )
      return false;
    if (w < 7 || h < 3) return false;
    let overlap = 0;
    p.data.forEach((v, i) => {
      if (v)
        overlap += Number(
          Boolean(selected[(y + Math.floor(i / w)) * bounds.w + x + (i % w)]),
        );
    });
    return overlap > 0.62 * p.area;
  });
}

/** Only the detached source ink with support from the detected glyph is
 * selected. The curved border and the thin ruling often share its OCR box. */
export function measureRuledSound(
  source: Buffer,
  size: Size & {
    sourceRect: PixelRect;
    block: Pick<TranslationBlock, "sourceText" | "textRole">;
  },
  instance: InpaintingWindowMask,
) {
  const { sourceRect: rect, block } = size;
  const reading = block.sourceText.normalize("NFKC").trim();
  if (
    block.textRole !== "sound" ||
    !verticalKana.test(reading) ||
    !smallVerticalType(rect)
  )
    return;
  const bounds = expandRect(rect, size.width, size.height, 10);
  const gray = nativeLuminance(source, size.width, bounds);
  const parts = supportedStrokes(gray, bounds, rect, instance);
  if (parts.length < 3 || parts.length > 12) return;
  const ink = new Uint8Array(gray.length);
  for (const p of parts) mergeMaskIntoPage(ink, bounds.w, p.rect, p.data);
  const active = maskBoundsInRect(ink, bounds.w, {
    x: 0,
    y: 0,
    w: bounds.w,
    h: bounds.h,
  });
  if (!active || active.h < 0.62 * rect.h) return;
  const data = Uint8Array.from(distanceToMask(ink, bounds.w, bounds.h), (v) =>
    Number(v <= 7.4),
  );
  const mask = {
    bounds,
    data,
    soundReading: reading,
    measuredSoundOutline: true,
  };
  if (
    ruledStock(source, size, mask, {
      x: active.x + bounds.x - 7,
      y: active.y + bounds.y - 7,
      w: active.w + 14,
      h: active.h + 14,
    })
  )
    return mask;
}

function smallVerticalType(rect: PixelRect) {
  return (
    rect.h >= 46 &&
    rect.h <= 200 &&
    rect.w >= 20 &&
    rect.w <= 115 &&
    rect.h >= 1.35 * rect.w
  );
}

export function restoreRuledSoundPaper(
  source: Buffer,
  stencil: Uint8Array,
  size: Size,
  hint: unknown,
) {
  if (
    typeof hint !== "string" ||
    !hint.startsWith("sound:") ||
    !verticalKana.test(hint.slice(6))
  )
    return;
  const bounds = { x: 0, y: 0, w: size.width, h: size.height };
  const active = maskBoundsInRect(stencil, size.width, bounds);
  if (!active || active.h > 220 || active.w > 135) return;
  const stock = ruledStock(source, size, { bounds, data: stencil }, active);
  if (!stock) return;
  const { local, levels } = stock;
  const out = Buffer.from(source);
  for (let i = 0; i < local.data.length; i++) {
    if (!local.data[i]) continue;
    const x = i % local.bounds.w,
      y = Math.floor(i / local.bounds.w);
    const at = 4 * ((local.bounds.y + y) * size.width + local.bounds.x + x);
    out.fill(Math.round(levels[x]), at, at + 3);
  }
  return out;
}
