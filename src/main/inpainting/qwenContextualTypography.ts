import type { FluxPlanOptions } from "./qwenSelectedPlan";
import { bboxOverlapRatio, normalizeBboxTo1000 } from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import type {
  ComicPageDetectionResult,
  KoharuTypographySegmentation,
} from "../bubbleLayout/contracts";
import type { BubbleLayoutBlockPatch } from "./bubbleLayoutRunnerPatches";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  nativeKoharuTextInstance,
  unionWindowMasks,
} from "./koharuTypographyMask";
import { bboxToPixelRect, type PixelRect } from "./maskGeometry";
import { hasPairedCreatorCredit } from "./qwenCreatorCaption";

type Target = {
  id: string;
  selected: PixelRect;
  full?: InpaintingWindowMask;
  effect?: boolean;
};

/** A small, weak instance on illustrated artwork can be truncated at page
 * scale. Keep the selected block and its original instance as independent
 * bounds on the predictions made while viewing that part of the drawing. */
export function contextualTextTargets(
  page: MangaPage,
  segmentation: KoharuTypographySegmentation,
  patches: readonly BubbleLayoutBlockPatch[],
  selectedIds?: readonly string[],
): Target[] {
  const constrained = new Set(
    patches.filter((p) => p.sourceEraseConstraint).map((p) => p.blockId),
  );
  const sources = page.blocks.map((block) => ({
    block,
    rect: bboxToPixelRect(
      normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
      page,
    ),
  }));
  const targets: Target[] = [];
  const weak = segmentation.detections.filter(
    (d) => d.label === "text" && d.mask && d.score < 0.4,
  );
  for (const { block, rect } of sources) {
    if (
      constrained.has(block.id) ||
      block.bubbleLayout?.origin === "manual" ||
      (selectedIds && !selectedIds.includes(block.id))
    )
      continue;
    if (
      sources.some(
        (other) =>
          other.block.id !== block.id &&
          bboxOverlapRatio(rect, other.rect) > 0.12,
      )
    )
      continue;
    if (isUndetectedCaption(block.sourceText, rect, page, segmentation)) {
      targets.push({ id: block.id, selected: rect });
      continue;
    }
    const full = weakSelectedInstance(page, rect, weak);
    if (full) targets.push({ id: block.id, selected: rect, full });
    else if (isUnmatchedEffect(block, rect, segmentation))
      targets.push({ id: block.id, selected: rect, effect: true });
  }
  return targets;
}

function isUnmatchedEffect(
  block: MangaPage["blocks"][number],
  rect: PixelRect,
  segmentation: KoharuTypographySegmentation,
) {
  const reading = block.sourceText.normalize("NFKC").trim();
  const syllables = reading.replace(
    /(?<=[\p{Script=Hiragana}\p{Script=Katakana}])\.{2,3}/gu,
    "",
  );
  if (
    block.textRole !== "sound" &&
    !/^[\p{Script=Hiragana}\p{Script=Katakana}ー!?]{1,8}$/u.test(syllables)
  )
    return false;
  const area = rect.w * rect.h;
  if (
    Math.min(rect.w, rect.h) < 16 ||
    area >= 0.16 * segmentation.imageWidth * segmentation.imageHeight
  )
    return false;
  return !segmentation.detections.some((d) => {
    if (d.label !== "text" && d.label !== "onomatopoeia") return false;
    const [x, y, right, bottom] = d.box;
    const box = { x, y, w: right - x, h: bottom - y };
    return box.w * box.h >= 0.28 * area && bboxOverlapRatio(box, rect) > 0.68;
  });
}

function weakSelectedInstance(
  page: MangaPage,
  rect: PixelRect,
  weak: KoharuTypographySegmentation["detections"],
) {
  if (
    Math.max(rect.w, rect.h) > 0.18 * Math.min(page.width, page.height) ||
    Math.min(rect.w, rect.h) < 22
  )
    return;
  const hits = weak.filter((d) => {
    const [x, y, r, b] = d.box;
    const bounds = { x, y, w: r - x, h: b - y };
    return (
      bboxOverlapRatio(bounds, rect) > 0.7 &&
      bounds.w * bounds.h > 0.16 * rect.w * rect.h
    );
  });
  if (hits.length === 1) return nativeKoharuTextInstance(hits[0], page);
}

function isUndetectedCaption(
  text: string,
  rect: PixelRect,
  page: MangaPage,
  segmentation: KoharuTypographySegmentation,
) {
  const normalized = text.normalize("NFKC").trim();
  const pairedCredit = hasPairedCreatorCredit(normalized);
  const credit =
    /[[【(](?:原作|原案|作画|漫画|キャラクター|イラスト|脚本|글|그림|원작)/u.test(
      normalized,
    );
  const chapter =
    /^第\s*[0-9〇一二三四五六七八九十百]+\s*[話章](?:\s*[:・-]\s*|\s+)\S.{1,}/u.test(
      normalized,
    );
  if (
    (!credit && !chapter && !pairedCredit) ||
    rect.w < 48 ||
    rect.w < 1.6 * rect.h ||
    rect.w > 0.46 * Math.min(page.width, page.height)
  )
    return false;
  return !segmentation.detections.some((d) => {
    const [x, y, r, b] = d.box;
    return (
      d.label === "text" &&
      (!pairedCredit || (r - x) * (b - y) >= 0.74 * rect.w * rect.h) &&
      bboxOverlapRatio(rect, { x, y, w: r - x, h: b - y }) > 0.65
    );
  });
}

function contextView(
  rect: PixelRect,
  page: { width: number; height: number },
  factor: number,
  magnification = 2,
) {
  const width = Math.min(
    page.width,
    Math.max(
      Math.round(page.width * factor),
      Math.round(magnification * rect.w),
    ),
  );
  const height = Math.min(
    page.height,
    Math.max(
      Math.round(page.height * factor),
      Math.round(magnification * rect.h),
    ),
  );
  const x = Math.max(
    0,
    Math.min(page.width - width, Math.round(rect.x + (rect.w - width) / 2)),
  );
  const y = Math.max(
    0,
    Math.min(page.height - height, Math.round(rect.y + (rect.h - height) / 2)),
  );
  return { x, y, width, height };
}

type View = ReturnType<typeof contextView>;
type DetectView = (view: View) => Promise<ComicPageDetectionResult>;

export async function refineContextualText(
  page: { width: number; height: number },
  targets: readonly Target[],
  detect: DetectView,
  signal: AbortSignal,
) {
  const contextualText = new Map<
    string,
    InpaintingWindowMask & { label?: "onomatopoeia" }
  >();
  for (const target of targets) {
    let combined: InpaintingWindowMask | undefined;
    const previous = new Set<string>();
    const observed: InpaintingWindowMask[] = [];
    const views = target.effect
      ? [
          [0.16, 1.8],
          [0.24, 2.4],
          [0.34, 3.2],
        ]
      : target.full
        ? [
            [0.3, 2],
            [0.37, 2],
          ]
        : [
            [0.15, 1.9],
            [0.17, 2.1],
            [0.18, 2.1],
            [0.19, 1.9],
          ];
    for (const [factor, magnification] of views) {
      signal.throwIfAborted();
      const view = contextView(target.selected, page, factor, magnification);
      const key = [view.x, view.y, view.width, view.height].join(",");
      if (previous.has(key)) continue;
      previous.add(key);
      const result = await detect(view);
      signal.throwIfAborted();
      combined = mergeSelectedText(target, result, view, observed, combined);
    }
    if (combined && (target.full || coversSelection(combined)))
      contextualText.set(
        target.id,
        target.effect ? { ...combined, label: "onomatopoeia" } : combined,
      );
  }
  return contextualText;
}

function coversSelection(mask: InpaintingWindowMask) {
  const { w, h } = mask.bounds;
  let left = w,
    right = -1,
    top = h,
    bottom = -1;
  for (let i = 0; i < mask.data.length; i++)
    if (mask.data[i]) {
      left = Math.min(left, i % w);
      right = Math.max(right, i % w);
      top = Math.min(top, Math.floor(i / w));
      bottom = Math.max(bottom, Math.floor(i / w));
    }
  return right - left + 1 >= 0.6 * w && bottom - top + 1 >= 0.48 * h;
}

function mergeSelectedText(
  target: Target,
  result: ComicPageDetectionResult,
  view: View,
  observed: InpaintingWindowMask[],
  combined?: InpaintingWindowMask,
) {
  const current: InpaintingWindowMask[] = [];
  for (const d of result.detections) {
    const native = nativeKoharuTextInstance(
      d,
      view,
      target.effect ? "onomatopoeia" : "text",
    );
    if (!native) continue;
    const addition = contextualAddition(target, native, view);
    if (!addition) continue;
    let confirmed = addition;
    if (!target.full) {
      current.push(addition);
      const prior = observed.find((previous) =>
        corroboratesInk(previous, addition),
      );
      if (!prior) continue;
      confirmed = unionWindowMasks(prior, addition);
    }
    combined = combined ? unionWindowMasks(combined, confirmed) : confirmed;
  }
  observed.push(...current);
  return combined;
}

function corroboratesInk(
  first: InpaintingWindowMask,
  second: InpaintingWindowMask,
) {
  let shared = 0,
    firstArea = 0,
    secondArea = 0;
  for (let i = 0; i < first.data.length; i++) {
    firstArea += Number(Boolean(first.data[i]));
    secondArea += Number(Boolean(second.data[i]));
    shared += Number(Boolean(first.data[i] && second.data[i]));
  }
  return shared >= 0.65 * Math.max(firstArea, secondArea);
}

function contextualAddition(
  target: Target,
  local: InpaintingWindowMask,
  view: View,
) {
  const { selected, full } = target;
  const registered = {
    data: local.data,
    bounds: {
      ...local.bounds,
      x: view.x + local.bounds.x,
      y: view.y + local.bounds.y,
    },
  };
  const pixels = projectWindowMask(registered, selected);
  if (!full) return selectedLocalPrint(local, selected, pixels, target.effect);
  const parent = projectWindowMask(full, selected);
  let proposed = 0,
    overlap = 0,
    original = 0;
  for (let i = 0; i < pixels.length; i++) {
    proposed += Number(!!pixels[i]);
    original += Number(!!parent[i]);
    if (parent[i] && pixels[i]) overlap++;
  }
  const total = local.data.reduce((sum, px) => sum + Number(!!px), 0);
  if (
    proposed < 0.8 * total ||
    overlap < 0.5 * Math.min(proposed, original) ||
    overlap < 30 ||
    proposed - overlap < 9
  )
    return;
  return { bounds: selected, data: pixels };
}

function selectedLocalPrint(
  local: InpaintingWindowMask,
  selected: PixelRect,
  pixels: Uint8Array,
  effect = false,
) {
  const area = pixels.reduce((n, v) => n + Number(Boolean(v)), 0);
  const total = local.data.reduce((n, v) => n + Number(Boolean(v)), 0);
  if (
    area >= 40 &&
    area >= 0.9 * total &&
    (effect ||
      (local.bounds.w >= 1.5 * local.bounds.h &&
        local.bounds.w >= 0.18 * selected.w))
  )
    return { bounds: selected, data: pixels };
}

export function sharesDetectedBalloon(
  options: FluxPlanOptions,
  rect: PixelRect,
) {
  const peers = options.page.blocks
    .filter((block) => block.id !== options.block.id)
    .map((block) =>
      bboxToPixelRect(
        normalizeBboxTo1000(block.bbox, options.page, block.bboxSpace),
        options.page,
      ),
    );
  if (peers.some((peer) => bboxOverlapRatio(rect, peer) > 0)) return false;
  return options.segmentation?.detections.some(
    ({ label, box: [l, t, r, b] }) =>
      label === "bubble" &&
      rect.x >= l &&
      rect.y >= t &&
      rect.x + rect.w <= r &&
      rect.y + rect.h <= b &&
      peers.some((peer) => {
        const x = peer.x + peer.w / 2,
          y = peer.y + peer.h / 2;
        return x > l && x < r && y > t && y < b;
      }),
  );
}
