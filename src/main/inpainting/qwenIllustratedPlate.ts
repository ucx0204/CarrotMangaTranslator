import type { PatternMaskContext } from "./patternMaskContext";
import type { IllustratedTitleHint } from "./fluxWorkerTypes";
import type { PrintSelection } from "./qwenSelectedPlan";
import type { TranslationBlock } from "../../shared/textTypes";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { trimWindowMask } from "./koharuTypographyMask";
import {
  expandRect,
  rectsTouchOrOverlap,
  type PixelRect,
} from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { largeIllustratedWindow } from "./qwenTextArtwork";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";

/** The model owns the selected lettering. Its registered edit can meet the
 * untouched image anywhere within this narrow original-resolution rim. */
export function illustratedPlateEnvelope(
  mask: InpaintingWindowMask,
  bounds: PixelRect,
  radius: number,
) {
  const core = projectWindowMask(mask, bounds);
  const distance = distanceToMask(core, bounds.w, bounds.h);
  return trimWindowMask({
    bounds,
    data: Uint8Array.from(distance, (v) => Number(v < radius)),
  });
}

/** Display lettering printed as a single white knockout can include a
 * cartouche, fine rules and stock between adjacent rows. Identify that stock
 * on the original, before sampling the surrounding illustration. */
export function measuredIllustratedPlate(
  bitmap: Buffer,
  pageWidth: number,
  mask: InpaintingWindowMask,
  bounds: PixelRect,
) {
  const { w, h } = bounds;
  if (w * h > 1_300_000 || Math.min(w, h) < 64) return;
  const core = projectWindowMask(mask, bounds);
  const distance = distanceToMask(core, w, h);
  const gray = Uint8Array.from(core, (_, i) => {
    const p =
      4 * ((bounds.y + Math.floor(i / w)) * pageWidth + bounds.x + (i % w));
    return Math.min(bitmap[p], bitmap[p + 1], bitmap[p + 2]);
  });
  if (!hasWhitePrintRim(gray, distance)) return;
  const radius = Math.min(
    11,
    Math.max(5, Math.round(0.025 * Math.min(mask.bounds.w, mask.bounds.h))),
  );
  const outside = Uint8Array.from(distance, (d) => Number(d > radius));
  const enclosed = distanceToMask(outside, w, h);
  const paper = core.map((_, i) =>
    Number(gray[i] > 241 && distance[i] < radius + 2),
  );
  const toPaper = distanceToMask(paper, w, h);
  const measured = core.slice();
  for (let i = 0; i < measured.length; i++) {
    if (distance[i] > radius + 1) continue;
    if (enclosed[i] > radius || paper[i] || toPaper[i] < 2.5) measured[i] = 1;
  }
  if (!measured.some((v, i) => v && !core[i])) return;
  return trimWindowMask({ bounds, data: measured });
}

function hasWhitePrintRim(gray: Uint8Array, distance: Float32Array) {
  let inside = 0,
    ink = 0,
    white = 0,
    near = 0,
    nearWhite = 0,
    far = 0,
    farWhite = 0;
  for (let i = 0; i < gray.length; i++) {
    const d = distance[i],
      v = gray[i];
    if (d === 0) {
      inside++;
      ink += Number(v < 130);
      white += Number(v >= 245);
    } else if (d < 3.1) {
      near++;
      nearWhite += Number(v >= 245);
    } else if (d > 10 && d < 17) {
      far++;
      farWhite += Number(v >= 245);
    }
  }
  if (near < 50 || far < 50 || inside < 400) return false;
  return (
    ink > inside * 0.06 &&
    white > inside * 0.23 &&
    nearWhite / near > farWhite / far + 0.055
  );
}

export function selectedPrintGroups(
  blockId: string,
  plan: PrintSelection & { speechBubble: boolean },
  shared: string[],
) {
  if (typeof plan.isolatedTitleStock === "string")
    return ["qwen-" + plan.isolatedTitleStock + ":" + blockId];
  if (plan.isolatedTitleStock) return ["qwen-isolated-title-stock:" + blockId];
  if (plan.washedTitle !== undefined)
    return [
      `qwen-washed-title:${encodeURIComponent(plan.washedTitle)}:${blockId}`,
    ];
  if (plan.masthead) return ["qwen-masthead:" + blockId];
  if (plan.colouredCaption !== undefined)
    return [
      "qwen-pigment:" +
        encodeURIComponent(plan.colouredCaption) +
        ":" +
        blockId,
    ];
  if (plan.measuredBrush) {
    const type = plan.measuredBrush === true ? "brush" : plan.measuredBrush;
    return [
      `qwen-${type}:${blockId}`,
      "qwen-measured-sound-outline:" + blockId,
    ];
  }
  if (plan.measuredCaptionOutline) return ["qwen-caption-outline:" + blockId];
  if (plan.soundReading !== undefined) {
    const sound = `qwen-sound:${encodeURIComponent(plan.soundReading)}:${blockId}`;
    return plan.measuredSoundOutline
      ? [sound, `qwen-measured-sound-outline:${blockId}`]
      : [sound];
  }
  return plan.speechBubble ? shared : [];
}

export function isMeasuredSoundGroup(ids: readonly string[]) {
  return ids.some((id) => id.startsWith("qwen-measured-sound-outline:"));
}

/** An outer optical wash may meet a separately selected label. Its source
 * pixels belong to that label in both the model and the final compositor. */
export function reserveDisplayNeighbours(
  measured: InpaintingWindowMask,
  envelope: InpaintingWindowMask,
  windows: InpaintingWindowMask[],
  index: number,
) {
  const data = measured.data.slice(),
    paste = envelope.data.slice();
  for (const [i, peer] of windows.entries()) {
    if (
      i === index ||
      !rectsTouchOrOverlap(envelope.bounds, peer.bounds) ||
      peer.bounds.w > 0.55 * measured.bounds.w ||
      peer.bounds.h > 0.55 * measured.bounds.h
    )
      continue;
    const inside = projectWindowMask(measured, peer.bounds);
    let total = 0,
      shared = 0;
    peer.data.forEach((on, j) => {
      if (!on) return;
      total++;
      if (inside[j]) shared++;
    });
    if (!total || shared > 0.14 * total) continue;
    const core = projectWindowMask(peer, measured.bounds);
    const reserved = projectWindowMask(peer, envelope.bounds);
    for (let j = 0; j < data.length; j++) if (core[j]) data[j] = 0;
    for (let j = 0; j < paste.length; j++) if (reserved[j]) paste[j] = 0;
  }
  return {
    measured: { bounds: measured.bounds, data },
    envelope: { bounds: envelope.bounds, data: paste },
    masthead: false,
  };
}

/** A dialogue detection may span the first pixels of a separately selected
 * sound. Keep its optically measured knockout whole when reserving the cores. */
export function reserveMeasuredSounds(
  context: Pick<
    PatternMaskContext,
    | "inpaintWindowGroupIds"
    | "inpaintSpeechBubbleWindows"
    | "inpaintWindowMasks"
  >,
) {
  const masks = context.inpaintWindowMasks;
  const sounds = Array.from(masks.keys()).filter((i) =>
    isMeasuredSoundGroup(context.inpaintWindowGroupIds[i]),
  );
  if (!sounds.length) return;
  const order = new Set<number>();
  for (const [i, speech] of context.inpaintSpeechBubbleWindows.entries()) {
    if (speech && !sounds.includes(i)) {
      masks[i] = reserveSpeechNeighbours(masks[i], sounds, masks, order);
    }
    order.add(i);
  }
  const indices = [...order];
  return indices.some((value, index) => value !== index) ? indices : undefined;
}

function reserveSpeechNeighbours(
  mask: InpaintingWindowMask,
  sounds: number[],
  masks: InpaintingWindowMask[],
  order: Set<number>,
) {
  let data: Uint8Array | undefined;
  for (const neighbour of sounds) {
    const sound = masks[neighbour];
    if (!rectsTouchOrOverlap(mask.bounds, sound.bounds)) continue;
    const reserved = projectWindowMask(sound, mask.bounds);
    if (!mask.data.some((v, j) => v && reserved[j])) continue;
    // The next dialogue crop must see the erased sound at the shared edge.
    order.add(neighbour);
    data ??= mask.data.slice();
    for (let j = 0; j < data.length; j++) if (reserved[j]) data[j] = 0;
  }
  return data?.some(Boolean) ? { bounds: mask.bounds, data } : mask;
}

export function isIllustratedTitleGroup(
  ids: readonly string[],
): IllustratedTitleHint {
  for (const kind of [
    "jacket",
    "jacket-promo",
    "jacket-strap",
    "pigment",
    "layered-title",
    "washed-title",
  ] as const) {
    const group = ids.find((id) => id.startsWith("qwen-" + kind + ":"));
    if (group) return `${kind}:${decodeURIComponent(group.split(":")[1])}`;
  }
  const edition = ids.find((id) => id.startsWith("qwen-edition:"));
  if (edition)
    return `edition:${decodeURIComponent(edition.slice("qwen-edition:".length))}`;
  const lines = ids.find((id) => id.startsWith("qwen-masthead-lines:"));
  const columns = ids.find((id) => id.startsWith("qwen-cover-columns:"));
  if (columns)
    return `cover-columns:${decodeURIComponent(columns.split(":")[1])}`;
  if (lines) return `masthead:${decodeURIComponent(lines.split(":")[1])}`;
  const title = ids.find((id) => id.startsWith("qwen-magazine-credit:"));
  if (title) return `cover-title:${decodeURIComponent(title.split(":")[1])}`;
  const direct = (
    [
      "masthead",
      "brush",
      "solid-impact",
      "isolated-title-stock",
      "duotone-overlay",
      "ruled-sound-shadow",
      "balloon-edge-reading",
    ] as const
  ).find((mode) => ids.some((id) => id.startsWith("qwen-" + mode + ":")));
  if (direct) return direct;
  const sound = ids.find((id) => id.startsWith("qwen-sound:"));
  if (sound) return `sound:${decodeURIComponent(sound.split(":")[1])}`;
  if (ids.includes("qwen-printed-art")) return "lettering";
  if (ids.includes("qwen-illustrated-caption")) return "caption";
  return ids.some((id) => id.startsWith("qwen-illustrated-title:"));
}

/** Large magazine titles have white letter faces, coloured rims and small
 * inset subtitles. Include the selected line's pale print even when the
 * layout segmenter splits a character with a diagonal gap. */
export function completeMagazineLine(
  bitmap: Buffer,
  width: number,
  height: number,
  mask: InpaintingWindowMask,
) {
  const bounds = expandRect(mask.bounds, width, height, 8);
  if (bounds.w * bounds.h > 1_300_000) return mask;
  const core = projectWindowMask(mask, bounds);
  const paper = core.map((_, i) => {
    const p =
      4 *
      ((bounds.y + Math.floor(i / bounds.w)) * width +
        bounds.x +
        (i % bounds.w));
    const low = Math.min(bitmap[p], bitmap[p + 1], bitmap[p + 2]);
    const high = Math.max(bitmap[p], bitmap[p + 1], bitmap[p + 2]);
    return Number(low > 211 && high - low < 41);
  });
  if (!paper.some(Boolean)) return mask;
  const halo = distanceToMask(paper, bounds.w, bounds.h);
  return trimWindowMask({
    bounds,
    data: core.map((on, i) => Number(on || halo[i] < 17)),
  });
}

function printedEdition(
  block: Pick<TranslationBlock, "sourceText" | "textRole"> | undefined,
  mask: InpaintingWindowMask,
  bitmap: Buffer,
  stride: number,
) {
  const reading = block?.sourceText
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ");
  if (
    block?.textRole !== "ordinary" ||
    !reading ||
    reading.length > 36 ||
    !/(?:19|20)\d{2}/u.test(reading) ||
    !/(?:\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b|\d{1,2}\s*月\s*号)/iu.test(
      reading,
    ) ||
    Math.min(mask.bounds.w, mask.bounds.h) < 48
  )
    return;
  const pigment = new Uint32Array(4096);
  let samples = 0,
    dominant = 0;
  mask.data.forEach((on, i) => {
    if (!on) return;
    samples++;
    const x = mask.bounds.x + (i % mask.bounds.w);
    const y = mask.bounds.y + Math.floor(i / mask.bounds.w);
    const p = 4 * (y * stride + x);
    const b = bitmap[p],
      g = bitmap[p + 1],
      r = bitmap[p + 2];
    if (Math.max(b, g, r) - Math.min(b, g, r) <= 42) return;
    const bin = (b >> 4) * 256 + (g >> 4) * 16 + (r >> 4);
    dominant = Math.max(dominant, ++pigment[bin]);
  });
  if (dominant >= Math.max(180, 0.027 * samples)) return reading;
}

export function resolveIllustratedPrintKind(
  ids: string[],
  speech: boolean,
  mask: InpaintingWindowMask,
  options: { bitmap: Buffer; width: number; page: { height: number } },
  block?: Pick<TranslationBlock, "sourceText" | "textRole">,
) {
  // Protecting unselected artwork can remove every pixel of a grouped
  // detection. Leave its empty validation mask for normal change accounting.
  if (!mask.data.some(Boolean)) return false;
  const known = isIllustratedTitleGroup(ids);
  if (known || speech) return known;
  const reading = printedEdition(block, mask, options.bitmap, options.width);
  if (reading) {
    ids.push("qwen-edition:" + encodeURIComponent(reading));
    return `edition:${reading}` as const;
  }
  if (
    !largeIllustratedWindow(
      options.bitmap,
      options.width,
      options.page.height,
      mask,
    )
  ) {
    if (
      block?.textRole === "ordinary" &&
      Array.from(block.sourceText.trim()).length >= 7 &&
      crossesDrawnContours(mask, options)
    ) {
      ids.push("qwen-illustrated-caption");
      return "caption" as const;
    }
    return false;
  }
  // The registered edit selects a seam beyond the ink. Share that envelope
  // with the outer compositor so it cannot put the original outline back.
  ids.push("qwen-printed-art");
  return "lettering" as const;
}

/** A caption can cover a few lines on otherwise white paper. Identify the
 * drawn contours ending at the print and continuing into the exposed art. */
function crossesDrawnContours(
  mask: InpaintingWindowMask,
  options: { bitmap: Buffer; width: number; page: { height: number } },
) {
  const { w, h } = mask.bounds;
  if (w < 36 || h < 90 || h < 1.15 * w) return false;
  const bounds = expandRect(
    mask.bounds,
    options.width,
    options.page.height,
    32,
  );
  const stencil = projectWindowMask(mask, bounds);
  const distance = distanceToMask(stencil, bounds.w, bounds.h);
  const gray = nativeLuminance(options.bitmap, options.width, bounds);
  const ink = gray.map((v, i) => Number(v < 150 && distance[i] > 2));
  let contours = 0;
  for (const part of maskComponents(ink, bounds.w, bounds.h, 24)) {
    const { rect } = part;
    if (Math.max(rect.w, rect.h) < 22) continue;
    let touching = 0,
      exposed = 0;
    part.data.forEach((on, i) => {
      if (!on) return;
      const x = rect.x + (i % rect.w),
        y = rect.y + Math.floor(i / rect.w),
        d = distance[y * bounds.w + x];
      touching += Number(d < 8);
      exposed += Number(d > 19);
    });
    if (touching >= 3 && exposed >= 8 && ++contours >= 2) return true;
  }
  return false;
}
