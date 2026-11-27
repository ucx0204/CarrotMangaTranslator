import { sharesDetectedBalloon } from "./qwenContextualTypography";
import {
  isIsolatedBalloonType,
  enclosedTypeFaces,
  onLightPaper,
} from "./qwenPaperBank";
import { bboxOverlapRatio, normalizeBboxTo1000 } from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import { fillEnclosedMaskHoles } from "../bubbleLayout/bubbleMaskComponents";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { BubbleLayoutBlockPatch } from "./bubbleLayoutRunnerPatches";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  buildKoharuTypographyCompositeMask,
  unionWindowMasks,
} from "./koharuTypographyMask";
import {
  bboxToPixelRect,
  expandRect,
  unionRects,
  type PixelRect,
  resolveBlockRenderBboxInPixels,
} from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { measureQwenPrintGlow } from "./qwenPrintGlow";
import { measureJointBalloonPrint } from "./sharedBubbleTextBridge";
import { registerBalloonDash } from "./qwenBalloonDash";

import type { FluxPlanOptions } from "./qwenSelectedPlan";

type Owner = {
  block: MangaPage["blocks"][number];
  source: InpaintingWindowMask["bounds"];
  render: InpaintingWindowMask["bounds"];
};

export function balloonPrintOutline(
  options: FluxPlanOptions,
  bitmap: Buffer,
  balloon: InpaintingWindowMask,
): Parameters<typeof buildKoharuTypographyCompositeMask>[0]["completeOutline"] {
  return (instance, hits) => {
    if (
      options.block.bubbleLayout?.origin === "manual" ||
      !hits.every((h) => h.label === "text")
    )
      return;
    const ellipsis =
      /[…⋯︙]|\.{3}/u.test(options.block.sourceText) &&
      options.repeatedGlyphs?.balloonEllipsis(
        instance,
        options.sourceRect,
        balloon,
      );
    return (
      ellipsis ||
      registerBalloonDash(
        bitmap,
        options.width,
        instance,
        options.sourceRect,
        balloon,
      )
    );
  };
}

function samePrintedBox(
  a: InpaintingWindowMask["bounds"],
  b: InpaintingWindowMask["bounds"],
) {
  const small = Math.min(a.w * a.h, b.w * b.h),
    large = Math.max(a.w * a.h, b.w * b.h);
  return bboxOverlapRatio(a, b) * small >= 0.75 * large;
}

/** If a speech balloon overlaps an independently detected sound, use the
 * reviewed source boxes to keep each instance in its own model crop. */
export function ownedPrintDetections(options: FluxPlanOptions) {
  const segments = options.segmentation;
  if (!segments || !options.conditionOnTypography) return segments;
  const sound = options.block.textRole === "sound";
  const others = options.page.blocks
    .filter((block) => block.id !== options.block.id)
    .map((block) => ({
      differentRole: (block.textRole === "sound") !== sound,
      rect: bboxToPixelRect(
        normalizeBboxTo1000(block.bbox, options.page, block.bboxSpace),
        options.page,
      ),
    }));
  if (!others.length) return segments;
  const excludedLabel = sound ? "text" : "onomatopoeia";
  const detections = segments.detections.filter((hit) => {
    if (hit.label !== "text" && hit.label !== "onomatopoeia") return true;
    const [x, y, right, bottom] = hit.box;
    const bounds = { x, y, w: right - x, h: bottom - y };
    if (samePrintedBox(options.sourceRect, bounds)) return true;
    // A sliver of a neighboring credit can fall inside an undetected title.
    // Its exact OCR owner is independent evidence that this is the wrong ink.
    const sliver =
      !options.fallbackConstraint &&
      bboxOverlapRatio(options.sourceRect, bounds) < 0.2;
    return !others.some(
      (peer) =>
        (sliver || (hit.label === excludedLabel && peer.differentRole)) &&
        samePrintedBox(peer.rect, bounds),
    );
  });
  return detections.length === segments.detections.length
    ? segments
    : { ...segments, detections };
}

/** An automatic balloon may contain a hole in its inferred paper exactly
 * over part of a detected glyph. Only the corroborated face and its measured
 * print shoulder can reclaim that hole. A cut open to the exterior stays open. */
export function registerEnclosedType(
  options: FluxPlanOptions,
  typography: { core: InpaintingWindowMask; instance: InpaintingWindowMask },
  fallback: InpaintingWindowMask,
) {
  const owner = options.selectedBalloonConstraint ?? fallback;
  if (
    !options.bitmap ||
    !options.conditionOnTypography ||
    options.block.bubbleLayout?.origin !== "detected"
  )
    return owner;
  const paper = selectedBalloonPaper(
    options,
    options.bitmap,
    typography.instance,
    owner,
  );
  if (paper) return unionWindowMasks(owner, paper);
  return completeTypeHole(
    options.bitmap,
    options.width,
    options.sourceRect,
    typography.instance,
    owner,
    typography.core,
  );
}

/** A partition between two dialogue blocks can bisect an otherwise complete
 * text instance. Reclaim only the ink shoulder on independently measured blank
 * paper inside the selected OCR box. Other text owners retain their pixels. */
function selectedBalloonPaper(
  options: FluxPlanOptions,
  bitmap: Buffer,
  instance: InpaintingWindowMask,
  owner: InpaintingWindowMask,
): InpaintingWindowMask | undefined {
  const rect = options.sourceRect,
    hit = instance.bounds;
  if (
    options.block.textRole === "sound" ||
    !options.block.sourceText.trim() ||
    rect.w * rect.h > 150000 ||
    !containsRect(rect, hit)
  )
    return;
  const detected = projectWindowMask(instance, rect),
    owned = projectWindowMask(owner, rect);
  if (!detected.some((on, i) => on && !owned[i])) return;
  if (!sharesDetectedBalloon(options, rect)) return;
  const reach = distanceToMask(detected, rect.w, rect.h);
  if (
    !isIsolatedBalloonType(bitmap, options.width, rect, detected, owned, reach)
  )
    return;
  return {
    bounds: rect,
    data: Uint8Array.from(reach, (d) => Number(d <= 3.5)),
  };
}

function completeTypeHole(
  bitmap: Buffer,
  width: number,
  selected: InpaintingWindowMask["bounds"],
  instance: InpaintingWindowMask,
  owner: InpaintingWindowMask,
  core: InpaintingWindowMask,
) {
  const { bounds } = core;
  if (bounds.w * bounds.h > 150000) return owner;
  const owned = projectWindowMask(owner, bounds),
    detected = projectWindowMask(instance, bounds);
  if (!detected.some((on, i) => !!on && !owned[i])) return owner;
  const filled = fillEnclosedMaskHoles(owned, bounds.w, bounds.h);
  const holes = filled.map((on, i) => Number(!!on && !owned[i]));
  if (!detected.some((on, i) => !!on && !!holes[i])) return owner;
  const tone = new Uint8Array(owned.length),
    dark = new Uint8Array(owned.length);
  for (let i = 0; i < tone.length; i++) {
    const x = bounds.x + (i % bounds.w),
      y = bounds.y + Math.floor(i / bounds.w);
    const pos = 4 * (y * width + x);
    tone[i] = bitmap[pos + 1];
    dark[i] = Number(tone[i] < 166 && bitmap[pos + 3] === 255);
  }
  const ink = enclosedTypeFaces(
    bounds,
    selected,
    dark,
    detected,
    owned,
    holes,
    filled,
  );
  if (!ink.some(Boolean)) return owner;
  const reach = distanceToMask(ink, bounds.w, bounds.h);
  if (!onLightPaper(reach, detected, tone)) return owner;
  return unionWindowMasks(owner, {
    bounds,
    data: holes.map((v, i) => Number(!!v && reach[i] <= 3.5)),
  });
}

function isFreshSelectedPrint(
  patch: BubbleLayoutBlockPatch,
  targets?: readonly string[],
) {
  return (
    patch.bubbleLayout?.origin === "detected" &&
    !patch.sharedInpaintGroupIds?.length &&
    (!targets || targets.includes(patch.blockId))
  );
}

function hasAdjacentOwner(
  owner: Owner,
  owners: Owner[],
  patch: BubbleLayoutBlockPatch,
  patches: BubbleLayoutBlockPatch[],
) {
  // A one-block retry can omit group IDs even for a partitioned balloon.
  return (
    owners.some(
      (other) =>
        other !== owner &&
        (bboxOverlapRatio(owner.source, other.source) > 0 ||
          bboxOverlapRatio(owner.source, other.render) > 0),
    ) ||
    patches.some(
      (other) =>
        other !== patch &&
        other.sourceEraseConstraint &&
        bboxOverlapRatio(owner.source, other.sourceEraseConstraint.bounds) > 0,
    )
  );
}

/** Complete a freshly detected print outline before it becomes a write
 * constraint. Enclosed holes and the original artwork between glyphs survive. */
function completeExterior(
  bitmap: Buffer,
  width: number,
  selected: InpaintingWindowMask["bounds"],
  detected: InpaintingWindowMask,
  keyline: InpaintingWindowMask,
): InpaintingWindowMask | undefined {
  const { bounds } = keyline;
  const region = projectWindowMask(detected, bounds);
  const interior = fillEnclosedMaskHoles(region, bounds.w, bounds.h);
  const distance = distanceToMask(region, bounds.w, bounds.h);
  const added = new Uint8Array(region.length);
  for (let i = 0; i < region.length; i++) {
    if (interior[i] || !keyline.data[i] || distance[i] > 2) continue;
    const x = bounds.x + (i % bounds.w);
    const y = bounds.y + Math.floor(i / bounds.w);
    if (
      x < selected.x ||
      x >= selected.x + selected.w ||
      y < selected.y ||
      y >= selected.y + selected.h
    )
      continue;
    const p = (y * width + x) * 4;
    const luma =
      (29 * bitmap[p] + 150 * bitmap[p + 1] + 77 * bitmap[p + 2]) / 256;
    if (bitmap[p + 3] === 255 && luma > 136) added[i] = 1;
  }
  if (added.some(Boolean))
    return unionWindowMasks(detected, { bounds, data: added });
}

export function completeDetectedQwenPrintEdges(
  page: MangaPage,
  patches: BubbleLayoutBlockPatch[],
  segmentation: KoharuTypographySegmentation,
  bitmap: Buffer,
  signal: AbortSignal,
  targets?: readonly string[],
): BubbleLayoutBlockPatch[] {
  const { imageWidth: width, imageHeight: height } = segmentation;
  if (
    page.width !== width ||
    page.height !== height ||
    bitmap.length !== width * height * 4
  )
    return patches;
  const owners = page.blocks.map((block) => ({
    block,
    source: bboxToPixelRect(
      normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
      page,
    ),
    render: resolveBlockRenderBboxInPixels(block, page, width, height),
  }));
  return patches.map((patch) => {
    signal.throwIfAborted();
    const detected = patch.sourceEraseConstraint;
    const owner = owners.find(({ block }) => block.id === patch.blockId);
    if (
      !detected ||
      !owner ||
      owner.block.bubbleLayout?.origin === "manual" ||
      !isFreshSelectedPrint(patch, targets)
    )
      return patch;
    if (hasAdjacentOwner(owner, owners, patch, patches)) return patch;
    const typography = buildKoharuTypographyCompositeMask({
      page,
      block: owner.block,
      sourceRect: owner.source,
      width,
      height,
      segmentation,
      ownedRegionMask: detected,
      coreDilationPx: 0,
      featherPx: 0,
    });
    if (!typography) return patch;
    const keyline = measureQwenPrintGlow(
      bitmap,
      { width, height },
      typography.instance,
      detected,
    );
    if (!keyline) return patch;
    const completed = completeExterior(
      bitmap,
      width,
      owner.source,
      detected,
      keyline,
    );
    return completed ? { ...patch, sourceEraseConstraint: completed } : patch;
  });
}

function containsRect(outer: PixelRect, inner: PixelRect) {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}
function selectedDialoguePair(
  options: FluxPlanOptions,
  selected: ReadonlySet<string>,
) {
  const { block, page, sourceRect } = options;
  const peers = page.blocks
    .filter((b) => b.id !== block.id)
    .map((b) => ({
      block: b,
      rect: bboxToPixelRect(
        normalizeBboxTo1000(b.bbox, page, b.bboxSpace),
        page,
      ),
    }));
  const members = peers.filter((p) => bboxOverlapRatio(sourceRect, p.rect) > 0);
  if (members.length !== 1) return;
  const partner = members[0];
  if (
    !selected.has(partner.block.id) ||
    partner.block.bubbleLayout?.origin !== "detected"
  )
    return;
  const joint = unionRects(sourceRect, partner.rect);
  if (peers.some((p) => p !== partner && bboxOverlapRatio(joint, p.rect) > 0))
    return;
  return {
    joint,
    boxes: [sourceRect, partner.rect],
    ids: [block.id, partner.block.id],
  };
}
/** Coalesce two overlapping OCR selections only when the same detected balloon
 * contains them and the original pixels independently confirm their ink. */
export function jointlySelectedBalloonPrint(
  options: FluxPlanOptions,
  instance: InpaintingWindowMask,
) {
  const { selectedDialogue: selected, bitmap, block, page } = options;
  if (
    !bitmap ||
    !selected?.has(block.id) ||
    block.bubbleLayout?.origin !== "detected"
  )
    return;
  const pair = selectedDialoguePair(options, selected);
  if (!pair || !containsRect(pair.joint, instance.bounds)) return;
  const inside = options.segmentation?.detections.some(
    ({ label, box: [x, y, r, b] }) =>
      label === "bubble" &&
      containsRect({ x, y, w: r - x, h: b - y }, pair.joint),
  );
  if (!inside) return;
  const frame = expandRect(pair.joint, page.width, page.height, 8);
  if (frame.w * frame.h > 180000) return;
  const ink = measureJointBalloonPrint(
    bitmap,
    page.width,
    pair.boxes,
    pair.joint,
    frame,
    projectWindowMask(instance, frame),
  );
  if (ink) return { ink, ids: pair.ids };
}
