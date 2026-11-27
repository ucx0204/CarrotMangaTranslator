import { measureBalloonEdgeReading } from "./qwenBalloonEdgeReading";
import { normalizeBboxTo1000 } from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import type { BubbleLayoutBlockPatch } from "./bubbleLayoutRunnerPatches";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { bboxToPixelRect, expandRect, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { measureQwenPaperGradient } from "./qwenPaperGradient";
import { unionWindowMasks } from "./koharuTypographyMask";

/** Extend only a fresh automatic owner, before it becomes the compositor's
 * hard boundary. A detected lobe can cut through the last kana or furigana.
 * The original paper and disconnected ink must independently identify it. */
export function completePaperOwners(
  page: MangaPage,
  patches: BubbleLayoutBlockPatch[],
  bitmap: Buffer,
  signal: AbortSignal,
  targets?: readonly string[],
) {
  const words = page.blocks.map((block) => ({
    block,
    rect: bboxToPixelRect(
      normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
      page,
    ),
  }));
  return patches.map((patch) => {
    signal.throwIfAborted();
    const word = words.find((w) => w.block.id === patch.blockId);
    const original = patch.sourceEraseConstraint;
    if (!original || !word || !isSelectedAutomatic(patch, word.block, targets))
      return patch;
    const peers = words.filter((w) => w !== word).map((w) => w.rect);
    const edge = measureBalloonEdgeReading({
      bitmap,
      page,
      word: word.rect,
      owner: original,
      reading: word.block.sourceText,
      peers,
    });
    if (edge)
      return {
        ...patch,
        sourceEraseConstraint: {
          ...unionWindowMasks(original, edge),
          outlinedReading: edge,
        },
      };
    const bounds = expandRect(word.rect, page.width, page.height, 14);
    const measured = measureQwenPaperGradient(
      bitmap,
      page.width,
      bounds,
      word.rect,
    );
    if (!measured) return patch;
    const fringe = measuredFringe(measured, original, word.rect, peers);
    return fringe
      ? { ...patch, sourceEraseConstraint: unionWindowMasks(original, fringe) }
      : patch;
  });
}

function isSelectedAutomatic(
  patch: BubbleLayoutBlockPatch,
  block: MangaPage["blocks"][number],
  targets?: readonly string[],
) {
  return (
    block.textRole === "ordinary" &&
    !!block.sourceText.trim() &&
    patch.bubbleLayout?.origin === "detected" &&
    block.bubbleLayout?.origin !== "manual" &&
    (!targets || targets.includes(block.id))
  );
}

export function measuredFringe(
  letters: InpaintingWindowMask,
  original: InpaintingWindowMask,
  word: PixelRect,
  peers: PixelRect[],
) {
  const { bounds, data } = letters;
  const owned = projectWindowMask(original, bounds),
    fringe = new Uint8Array(data.length);
  const distances = distanceToMask(owned, bounds.w, bounds.h);
  const reach = Math.min(48, Math.max(10, Math.min(word.w, word.h) * 1.1));
  let total = 0,
    extra = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    total++;
    if (owned[i]) continue;
    const x = bounds.x + (i % bounds.w),
      y = bounds.y + Math.floor(i / bounds.w);
    if (distances[i] > reach) return;
    if (peers.some((r) => inRect(x, y, r))) continue;
    fringe[i] = 1;
    extra++;
  }
  if (extra > 0 && extra <= 0.32 * total) return { bounds, data: fringe };
}

function inRect(x: number, y: number, r: PixelRect) {
  return x >= r.x - 1 && y >= r.y - 1 && x < r.x + r.w + 1 && y < r.y + r.h + 1;
}
