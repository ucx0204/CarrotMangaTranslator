import type { PatternMaskContext } from "./patternMaskContext";
import { bboxToPixelRect, unionRects, type PixelRect } from "./maskGeometry";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { MangaPage } from "../../shared/libraryTypes";
import { measuredJacketRow } from "./qwenMagazineInsets";
import {
  hasMagazineMasthead,
  bindMagazineLines,
  type PrintedLine,
} from "./qwenIllustratedTitleGroups";

export function groupMagazineInsets(
  context: PatternMaskContext,
  options: { page: MangaPage; bitmap: Buffer; width: number },
) {
  if (!hasMagazineMasthead(context)) return;
  const { page, bitmap, width } = options;
  const blocks = new Map(page.blocks.map((block) => [block.id, block]));
  const selected = context.validationBlockIds.flatMap((id, i) => {
    const block = blocks.get(id);
    if (
      !block ||
      context.inpaintSpeechBubbleWindows[i] ||
      !block.sourceText.trim()
    )
      return [];
    return [
      {
        i,
        available: true,
        rect: bboxToPixelRect(block.bbox, page),
        reading: block.sourceText.normalize("NFKC").trim(),
      },
    ];
  });
  const jackets = measuredJacketRow(
    { bitmap, width, height: page.height },
    selected.map((line) => line.rect),
  );
  if (!jackets.length) return;
  for (const jacket of jackets) {
    const contained = selected.filter(({ rect: b }) => {
      const dx =
        Math.min(b.x + b.w, jacket.x + jacket.w) - Math.max(b.x, jacket.x);
      const dy =
        Math.min(b.y + b.h, jacket.y + jacket.h) - Math.max(b.y, jacket.y);
      return dx > 0.51 * b.w && dy > 0.85 * b.h;
    });
    if (!contained.length) continue;
    bindMagazineLines(context, "qwen-jacket", contained);
    for (const { i } of contained) {
      context.inpaintWindows[i] = jacket;
      const cropped = {
        bounds: jacket,
        data: projectWindowMask(context.inpaintWindowMasks[i], jacket),
      };
      context.inpaintWindowMasks[i] = cropped;
      context.inpaintCompositeMasks[i] = cropped;
      context.inpaintWindowConstraints[i] = cropped;
    }
  }
  bindAdjacentJacketCredits(context, selected, jackets.reduce(unionRects));
}

function bindAdjacentJacketCredits(
  context: PatternMaskContext,
  selected: PrintedLine[],
  row: PixelRect,
) {
  for (const line of selected) {
    if (!line.available || context.inpaintWindowGroupIds[line.i].length)
      continue;
    const b = line.rect;
    if (!spansJacketRow(b, row)) continue;
    const gapAbove = row.y - b.y - b.h,
      gapBelow = b.y - row.y - row.h;
    if (gapAbove >= -2 && gapAbove < 0.32 * row.h)
      bindMagazineLines(context, "qwen-jacket-promo", [line]);
    else if (gapBelow >= -2 && gapBelow < 0.34 * row.h)
      bindMagazineLines(context, "qwen-jacket-strap", [line]);
  }
}

function spansJacketRow(b: PixelRect, row: PixelRect) {
  return !(
    b.w < 0.45 * row.w ||
    b.w > 1.3 * row.w ||
    b.w < 4.2 * b.h ||
    b.x < row.x - 0.08 * row.w ||
    b.x + b.w > row.x + 1.09 * row.w
  );
}
