import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  nativeKoharuTextInstance,
  unionWindowMasks,
} from "./koharuTypographyMask";
import { expandRect, type PixelRect } from "./maskGeometry";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { maskComponents } from "./rasterMasks";

import { registerBalloonEllipsis } from "./qwenBalloonEllipsis";

type Size = { width: number; height: number };

type Glyph = InpaintingWindowMask & {
  area: number;
  owned: number;
  nearInk: number;
  shape?: Float32Array;
};

/** Compare only ink inside the selected OCR box. A partially segmented
 * terminal character needs two separate full specimens on this very page. */
export class QwenRepeatedGlyphs {
  private references?: Glyph[];

  static forPage(
    page: Size & {
      bitmap: Buffer;
      conditionOnTypography?: boolean;
      typographySegmentation?: KoharuTypographySegmentation;
    },
  ) {
    if (page.conditionOnTypography && page.typographySegmentation)
      return new QwenRepeatedGlyphs(
        page.bitmap,
        page,
        page.typographySegmentation,
      );
  }

  constructor(
    private readonly bitmap: Buffer,
    private readonly size: Size,
    private readonly segmentation: KoharuTypographySegmentation,
  ) {}

  balloonEllipsis(
    instance: InpaintingWindowMask,
    selection: PixelRect,
    balloon: InpaintingWindowMask,
  ) {
    return registerBalloonEllipsis(
      this.bitmap,
      this.size.width,
      instance,
      selection,
      balloon,
    );
  }

  complete(instance: InpaintingWindowMask, selection: PixelRect) {
    const glyphs = this.glyphs(instance, 6);
    const anchors = glyphs.filter(isFullyOwned);
    const partial = glyphs.filter(
      (s) =>
        s.owned <= 0.33 * s.area &&
        insideSelection(s.bounds, selection) &&
        alignedWithText(s, anchors),
    );
    if (!partial.length) return;
    this.references ??= this.collectReferences();
    let result: InpaintingWindowMask | undefined;
    for (const s of partial) {
      const repeated = this.references.filter(
        (r) => similarTypeSize(s, r) && shapeAgreement(s, r) >= 0.79,
      );
      if (repeated.length < 2) continue;
      const bounds = expandRect(s.bounds, this.size.width, this.size.height, 3);
      const mark = {
        bounds,
        data: dilateBinaryMaskDisk(
          projectWindowMask(s, bounds),
          bounds.w,
          bounds.h,
          3,
        ),
      };
      result = result ? unionWindowMasks(result, mark) : mark;
    }
    return result;
  }

  private collectReferences() {
    const unique = new Map<string, Glyph>();
    for (const hit of this.segmentation.detections) {
      const mask = nativeKoharuTextInstance(hit, this.size);
      if (!mask) continue;
      for (const s of this.glyphs(mask).filter(isFullyOwned))
        unique.set(
          [s.bounds.x, s.bounds.y, s.bounds.w, s.bounds.h].join(","),
          s,
        );
    }
    return [...unique.values()];
  }

  private glyphs(instance: InpaintingWindowMask, margin = 0): Glyph[] {
    const { width, height } = this.size,
      box = expandRect(instance.bounds, width, height, 45);
    if (box.w * box.h > 1_300_000) return [];
    const selected = projectWindowMask(instance, box);
    // The detector often samples the dark center of a typeset stroke.
    // Verify its antialias shoulder separately from direct ink ownership.
    const core = dilateBinaryMaskDisk(selected, box.w, box.h, 3);
    const adjacent = margin
      ? dilateBinaryMaskDisk(selected, box.w, box.h, margin)
      : selected;
    const dark = Uint8Array.from(selected, (_, i) => {
      const p =
        4 * ((box.y + Math.floor(i / box.w)) * width + box.x + (i % box.w));
      return Number(
        this.bitmap[p + 3] === 255 &&
          29 * this.bitmap[p] +
            150 * this.bitmap[p + 1] +
            77 * this.bitmap[p + 2] +
            128 <
            172 * 256,
      );
    });
    const glyphs: Glyph[] = [];
    for (const s of maskComponents(dark, box.w, box.h, 45)) {
      if (!isPrintableComponent(s, box)) continue;
      const { x, y, w, h } = s.rect;
      let owned = 0,
        near = 0,
        nearInk = 0;
      s.data.forEach((v, i) => {
        if (!v) return;
        const j = (y + Math.floor(i / w)) * box.w + x + (i % w);
        owned += Number(Boolean(selected[j]));
        nearInk += Number(Boolean(core[j]));
        near += Number(Boolean(adjacent[j]));
      });
      if (near >= 2)
        glyphs.push({
          bounds: { x: x + box.x, y: y + box.y, w, h },
          data: s.data,
          area: s.area,
          owned,
          nearInk,
        });
    }
    return glyphs;
  }
}

function isPrintableComponent(
  s: ReturnType<typeof maskComponents>[number],
  box: PixelRect,
) {
  const { x, y, w, h } = s.rect;
  return (
    x > 0 &&
    y > 0 &&
    x + w < box.w &&
    y + h < box.h &&
    Math.min(w, h) >= 7 &&
    Math.max(w, h) <= 65 &&
    s.area >= 0.1 * w * h &&
    s.area <= 0.72 * w * h
  );
}

function insideSelection(r: PixelRect, source: PixelRect) {
  return (
    r.x >= source.x - 2 &&
    r.y >= source.y - 2 &&
    r.x + r.w <= source.x + source.w + 2 &&
    r.y + r.h <= source.y + source.h + 2
  );
}

function isFullyOwned(s: Glyph) {
  return s.owned >= 0.5 * s.area && s.nearInk >= 0.97 * s.area;
}

function alignedWithText(s: Glyph, anchors: Glyph[]) {
  let horizontal = 0,
    vertical = 0;
  const { x, y, w, h } = s.bounds;
  for (const { bounds: b } of anchors) {
    const dx = Math.abs(x + w / 2 - b.x - b.w / 2) / w,
      dy = Math.abs(y + h / 2 - b.y - b.h / 2) / h;
    horizontal += Number(dy < 0.46 && dx >= 0.6 && dx <= 3.1);
    vertical += Number(dx < 0.46 && dy >= 0.6 && dy <= 3.1);
  }
  return Math.max(horizontal, vertical) >= 2;
}

function similarTypeSize(a: Glyph, b: Glyph) {
  return (
    Math.abs(b.bounds.w / a.bounds.w - 1) <= 0.17 &&
    Math.abs(b.bounds.h / a.bounds.h - 1) <= 0.17 &&
    Math.abs(b.area / a.area - 1) <= 0.21
  );
}

function shapeAgreement(a: Glyph, b: Glyph) {
  const u = (a.shape ??= normalizedInk(a)),
    v = (b.shape ??= normalizedInk(b));
  let intersection = 0,
    union = 0;
  for (let i = 0; i < u.length; i++) {
    intersection += Math.min(u[i], v[i]);
    union += Math.max(u[i], v[i]);
  }
  return intersection / union;
}

/** Area resampling retains the subpixel alignment of narrow stems. */
function normalizedInk(s: Glyph) {
  const side = 24,
    grid = new Float32Array(side * side),
    { w, h } = s.bounds;
  s.data.forEach((set, i) => {
    if (!set) return;
    const left = ((i % w) * side) / w,
      top = (Math.floor(i / w) * side) / h,
      right = left + side / w,
      bottom = top + side / h;
    for (let y = Math.floor(top); y < Math.min(side, Math.ceil(bottom)); y++)
      for (let x = Math.floor(left); x < Math.min(side, Math.ceil(right)); x++)
        grid[y * side + x] +=
          (Math.min(y + 1, bottom) - Math.max(y, top)) *
          (Math.min(x + 1, right) - Math.max(x, left));
  });
  return grid;
}
