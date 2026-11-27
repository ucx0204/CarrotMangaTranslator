import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { normalizeTranslationCompletionReferences } from "../translationCompletionReferences";
import { bboxToPixelRect, expandRect, hasUsableBbox } from "./maskGeometry";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { validateWindowMask } from "./inpaintingWindowMask";
import { unionWindowMasks } from "./koharuTypographyMask";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import {
  buildBubbleLayoutConstraintMask,
  projectWindowMask,
} from "./bubbleLayoutConstraintMask";
import { mastheadPeerInk } from "./qwenSpotColour";
import { measuredPeerShoulder } from "./sharedBubbleTextBridge";
import type { PixelRect } from "./maskGeometry";

/** Artwork SFX must not inherit the nearest dialogue balloon's erase boundary. */
function acceptsPatternBubbleConstraint(
  block: TranslationBlock,
  page: MangaPage,
  mask: InpaintingWindowMask,
): boolean {
  if (block.textRole !== "sound" || block.bubbleLayout?.origin === "manual")
    return true;
  const source = bboxToPixelRect(block.bbox, page);
  return Boolean(
    projectWindowMask(mask, {
      x: Math.floor(source.x + source.w / 2),
      y: Math.floor(source.y + source.h / 2),
      w: 1,
      h: 1,
    })[0],
  );
}

export function isPatternInpaintingBlockEligible(
  block: TranslationBlock,
  blockId?: string,
  excludedBlockIds?: readonly string[],
  blockIds?: readonly string[],
): boolean {
  const explicitlySelected =
    block.id === blockId || Boolean(blockIds?.includes(block.id));
  return (
    (!blockId || block.id === blockId) &&
    (!blockIds || blockIds.includes(block.id)) &&
    (blockId !== undefined || !excludedBlockIds?.includes(block.id)) &&
    hasUsableBbox(block.bbox) &&
    (!block.inpaintExcluded || explicitlySelected)
  );
}

export function resolveEligiblePatternBlocks(
  page: Pick<MangaPage, "blocks">,
  blockId?: string,
  excludedBlockIds?: readonly string[],
  blockIds?: readonly string[],
): TranslationBlock[] {
  return page.blocks.filter((block) =>
    isPatternInpaintingBlockEligible(
      block,
      blockId,
      excludedBlockIds,
      blockIds,
    ),
  );
}

export function countEligiblePatternBlocks(
  page: Pick<MangaPage, "blocks">,
  blockId?: string,
  excludedBlockIds?: readonly string[],
  blockIds?: readonly string[],
): number {
  return resolveEligiblePatternBlocks(page, blockId, excludedBlockIds, blockIds)
    .length;
}

export function hasInvalidRequiredPatternBlock(
  page: Pick<MangaPage, "blocks">,
): boolean {
  return page.blocks.some(
    (block) => !block.inpaintExcluded && !hasUsableBbox(block.bbox),
  );
}

export function shouldUseOriginalPatternImage(
  page: Pick<
    MangaPage,
    "blocks" | "inpaintedImagePath" | "translationCompletion"
  >,
): boolean {
  const completion = normalizeTranslationCompletionReferences(
    page.translationCompletion,
    page.blocks,
  );
  return Boolean(
    page.inpaintedImagePath &&
    completion?.status === "pending" &&
    !completion.erasedBlockIds?.length,
  );
}

/** Detector ownership is approximate; a selected balloon must not cut peer ink. */
function protectUnselectedPatternText(
  mask: InpaintingWindowMask,
  options: {
    page: MangaPage;
    blockId?: string;
    blockIds?: readonly string[];
    excludedBlockIds?: readonly string[];
    dialogueStrokes?: { bitmap: Buffer; model: InpaintingWindowMask };
  },
  peerBitmap?: Buffer,
): InpaintingWindowMask {
  const { bounds } = mask;
  let data: Uint8Array | undefined;
  for (const block of options.page.blocks) {
    // Pasted/render-only overlays can be excluded precisely because they have
    // no source ink. Their rectangles must not reserve another block's ink.
    if (
      block.inpaintExcluded ||
      !hasUsableBbox(block.bbox) ||
      isPatternInpaintingBlockEligible(
        block,
        options.blockId,
        options.excludedBlockIds,
        options.blockIds,
      )
    )
      continue;
    const rect = expandRect(
      bboxToPixelRect(block.bbox, options.page),
      options.page.width,
      options.page.height,
      2,
    );
    const left = Math.max(0, rect.x - bounds.x);
    const top = Math.max(0, rect.y - bounds.y);
    const right = Math.min(bounds.w, rect.x + rect.w - bounds.x);
    const bottom = Math.min(bounds.h, rect.y + rect.h - bounds.y);
    if (left >= right || top >= bottom) continue;
    data ??= mask.data.slice();
    const ink = peerTextInk(block, rect, options, peerBitmap);
    clearPeerPixels(data, bounds, { left, top, right, bottom }, ink);
  }
  return data ? { bounds, data } : mask;
}
function peerTextInk(
  block: TranslationBlock,
  rect: PixelRect,
  options: Parameters<typeof protectUnselectedPatternText>[1],
  peerBitmap?: Buffer,
) {
  if (!block.sourceText.trim()) return;
  if (peerBitmap) return mastheadPeerInk(peerBitmap, options.page.width, rect);
  const strokes = options.dialogueStrokes;
  if (
    strokes &&
    block.textRole !== "sound" &&
    block.bubbleLayout?.origin !== "manual"
  )
    return measuredDialoguePeerInk(
      strokes.bitmap,
      options.page,
      strokes.model,
      rect,
    );
}
function clearPeerPixels(
  data: Uint8Array,
  bounds: InpaintingWindowMask["bounds"],
  overlap: { left: number; top: number; right: number; bottom: number },
  ink?: InpaintingWindowMask,
) {
  const { left, top, right, bottom } = overlap;
  for (let y = top; y < bottom; y++) {
    if (!ink) {
      data.fill(0, y * bounds.w + left, y * bounds.w + right);
      continue;
    }
    const row =
      (bounds.y + y - ink.bounds.y) * ink.bounds.w + bounds.x - ink.bounds.x;
    for (let x = left; x < right; x++)
      if (ink.data[row + x]) data[y * bounds.w + x] = 0;
  }
}

export function protectUnselectedFluxPlan(
  plan: {
    modelMask: InpaintingWindowMask;
    compositeMask: InpaintingWindowMask;
    constraint: InpaintingWindowMask | null;
    featherPx: number;
  },
  options: Parameters<typeof protectUnselectedPatternText>[1] & {
    conditionOnTypography?: boolean;
  },
  peerBitmap?: Buffer,
): void {
  // Qwen conditions on the letters themselves. A nearby unselected drawing
  // must remain visible to the model when it reconstructs the chosen text.
  if (options.conditionOnTypography)
    plan.modelMask = protectUnselectedPatternText(plan.modelMask, options);
  plan.compositeMask = protectUnselectedPatternText(
    plan.compositeMask,
    options,
    peerBitmap,
  );
  // A fallback/SFX rectangle needs the same peer protection as a detected
  // balloon, including its outer feather. Keep legacy unconstrained output
  // exactly when no neighboring source ink intersects the write envelope.
  const bounds = expandRect(
    plan.compositeMask.bounds,
    options.page.width,
    options.page.height,
    plan.featherPx,
  );
  const envelope = plan.constraint ?? {
    bounds,
    data: new Uint8Array(bounds.w * bounds.h).fill(1),
  };
  const protectedEnvelope = protectUnselectedPatternText(
    envelope,
    options,
    peerBitmap,
  );
  if (plan.constraint || protectedEnvelope !== envelope)
    plan.constraint = protectedEnvelope;
}

type BalloonSelection = Parameters<typeof protectUnselectedPatternText>[1] & {
  width: number;
  height: number;
  conditionOnTypography?: boolean;
  typographySegmentation?: KoharuTypographySegmentation;
  sharedInpaintGroupIdsByBlock?: Readonly<Record<string, readonly string[]>>;
  bubbleLayoutConstraintBlockIds?: readonly string[];
  sourceEraseConstraintsByBlock?: Readonly<
    Record<string, InpaintingWindowMask>
  >;
};

/** A detected lobe can bisect the letters in an adjoining selected lobe.
 * Only the original erase rasters of selected members of that same balloon
 * may contribute to clipping the associated typography. */
export function sharedTypographyOwnership(
  options: BalloonSelection,
  block: MangaPage["blocks"][number],
  groupIds: string[],
  region: InpaintingWindowMask,
) {
  if (
    !options.conditionOnTypography ||
    !options.typographySegmentation ||
    !groupIds.length ||
    block.bubbleLayout?.origin === "manual"
  )
    return;
  let owned = region;
  const peers = resolveEligiblePatternBlocks(
    options.page,
    options.blockId,
    options.excludedBlockIds,
    options.blockIds,
  );
  for (const peer of peers) {
    if (!belongsToSelectedLobe(peer, block.id, groupIds, options)) continue;
    const raster = resolveFluxBubbleConstraint(options, peer);
    if (raster) owned = unionWindowMasks(owned, raster);
  }
  return owned === region ? undefined : owned;
}

function belongsToSelectedLobe(
  peer: TranslationBlock,
  source: string,
  group: string[],
  options: BalloonSelection,
) {
  return (
    peer.id !== source &&
    peer.bubbleLayout?.origin !== "manual" &&
    options.sharedInpaintGroupIdsByBlock?.[peer.id]?.some((id) =>
      group.includes(id),
    )
  );
}

export function resolveFluxBubbleConstraint(
  options: BalloonSelection,
  block: MangaPage["blocks"][number],
): InpaintingWindowMask | null {
  const bubbleMask = options.bubbleLayoutConstraintBlockIds?.includes(block.id)
    ? (options.sourceEraseConstraintsByBlock?.[block.id] ??
      buildBubbleLayoutConstraintMask(
        block,
        options.page,
        options.width,
        options.height,
        true,
      ))
    : null;
  if (bubbleMask) validateWindowMask(bubbleMask, options.width, options.height);
  if (
    bubbleMask &&
    !acceptsPatternBubbleConstraint(block, options.page, bubbleMask)
  )
    return null;
  return bubbleMask;
}

/** A block rectangle can graze a selected glyph. Keep the neighboring ink
 * reserved except for small tips physically connected to that selected glyph. */
export function measuredDialoguePeerInk(
  bitmap: Buffer,
  page: { width: number; height: number },
  model: InpaintingWindowMask,
  peer: PixelRect,
) {
  const b = model.bounds,
    x = Math.max(b.x, peer.x),
    y = Math.max(b.y, peer.y);
  const w = Math.min(b.x + b.w, peer.x + peer.w) - x,
    h = Math.min(b.y + b.h, peer.y + peer.h) - y;
  if (
    w <= 0 ||
    h <= 0 ||
    Math.min(w, h) > 5 ||
    Math.max(w, h) > 220 ||
    peer.w * peer.h > 200000
  )
    return;
  const frame = expandRect({ x, y, w, h }, page.width, page.height, 32);
  return measuredPeerShoulder(bitmap, page.width, frame, model, peer);
}
