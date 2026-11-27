import type { MangaPage } from "../../shared/libraryTypes";
import {
  completeOutlinedWhitePrint,
  measureLayeredTitle,
} from "./qwenCaptionEnvelope";
import { protectUnselectedFluxPlan } from "./patternBlockEligibility";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  bboxToPixelRect,
  mergeMaskIntoPage,
  unionRects,
  type PixelRect,
} from "./maskGeometry";
import { groupedDiamondBacking } from "./qwenDiamondStock";
import type { PatternMaskContext } from "./patternMaskContext";
import {
  completeMagazineLine,
  illustratedPlateEnvelope,
  isIllustratedTitleGroup,
  isMeasuredSoundGroup,
  measuredIllustratedPlate,
  resolveIllustratedPrintKind,
  reserveMeasuredSounds,
  reserveDisplayNeighbours,
} from "./qwenIllustratedPlate";
import { publisherRowComposite } from "./qwenPublisherRows";
import { groupMagazineInsets } from "./qwenMagazineGroups";
import { groupIllustratedTitleLines } from "./qwenIllustratedTitleGroups";

type SharedConstrainedWindowContext = {
  inpaintWindows: PixelRect[];
  inpaintWindowMasks: InpaintingWindowMask[];
  inpaintCompositeMasks: InpaintingWindowMask[];
  inpaintCompositeFeatherPx: number[];
  inpaintWindowConstraints: Array<InpaintingWindowMask | null>;
  inpaintWindowGroupIds: string[][];
  inpaintSpeechBubbleWindows: boolean[];
};

type SharedWindowEntry = {
  compositeMask: InpaintingWindowMask;
  constraint: InpaintingWindowMask | null;
  featherPx: number;
  groupIds: string[];
  mask: InpaintingWindowMask;
  window: PixelRect;
  speechBubble: boolean;
};

type GroupedRegionOptions = Parameters<typeof protectUnselectedFluxPlan>[1] & {
  bitmap: Buffer;
  width: number;
  mode?: string;
  typographySegmentation?: import("../bubbleLayout/contracts").KoharuTypographySegmentation;
};

export function prepareGroupedRegionWindows(
  context: PatternMaskContext,
  options: GroupedRegionOptions,
) {
  const title = options.mode === "flux-region" && options.conditionOnTypography;
  if (!title) {
    coalesceSharedConstrainedWindows(context);
    return;
  }
  groupMagazineInsets(context, options);
  groupIllustratedTitleLines(context, options.page);
  includeGroupedCaptionPlates(context, options);
  const publishers = groupedPublisherRows(context, options.page);
  const originalIndices = coalesceSharedConstrainedWindows(context);
  context.windowProcessingOrder = reserveMeasuredSounds(context);
  const selected = new Map(
    options.page.blocks.map((block) => [block.id, block]),
  );
  for (const [index, ids] of context.inpaintWindowGroupIds.entries()) {
    // The original knockout has already supplied the complete paste boundary.
    // Extending it again would replace visible artwork outside the printed rim.
    if (
      isMeasuredSoundGroup(ids) ||
      ids.some((id) =>
        /^qwen-(?:isolated-title-stock|duotone-overlay|ruled-sound-shadow|balloon-edge-reading):/.test(
          id,
        ),
      )
    )
      continue;
    const mask = context.inpaintWindowMasks[index];
    const kind = resolveIllustratedPrintKind(
      ids,
      context.inpaintSpeechBubbleWindows[index],
      mask,
      options,
      selected.get(context.validationBlockIds[originalIndices[index]]),
    );
    if (!kind || ids.some((id) => id.startsWith("qwen-caption-outline:")))
      continue;
    const { measured, envelope, masthead } = illustratedWindowEnvelope(
      context,
      index,
      kind,
      options,
      publishers,
    );
    const plate = {
      modelMask: measured,
      compositeMask: envelope,
      constraint: envelope,
      featherPx: 0,
    };
    protectUnselectedFluxPlan(
      plate,
      options,
      masthead ? options.bitmap : undefined,
    );
    context.inpaintWindowMasks[index] = plate.modelMask;
    context.inpaintCompositeMasks[index] = plate.compositeMask;
    context.inpaintWindowConstraints[index] = plate.constraint;
    context.inpaintCompositeFeatherPx[index] = 0;
    mergeMaskIntoPage(
      context.pageMask,
      options.width,
      plate.compositeMask.bounds,
      plate.compositeMask.data,
    );
  }
}

function illustratedWindowEnvelope(
  context: PatternMaskContext,
  index: number,
  kind: NonNullable<ReturnType<typeof resolveIllustratedPrintKind>>,
  options: GroupedRegionOptions,
  publishers: ReturnType<typeof groupedPublisherRows>,
) {
  const ids = context.inpaintWindowGroupIds[index],
    mask = context.inpaintWindowMasks[index];
  if (typeof kind === "string" && kind.startsWith("washed-title:"))
    return reserveDisplayNeighbours(
      mask,
      illustratedPlateEnvelope(mask, context.inpaintWindows[index], 72),
      context.inpaintWindowMasks,
      index,
    );
  const plate =
    kind !== true
      ? mask
      : (measuredIllustratedPlate(
          options.bitmap,
          options.width,
          mask,
          context.inpaintWindows[index],
        ) ?? mask);
  const measured =
    kind === true || kind === "lettering"
      ? completeOutlinedWhitePrint(
          options.bitmap,
          options.width,
          plate,
          context.inpaintWindows[index],
        )
      : plate;
  const bounded = publisherRowComposite(
    options,
    publishers.get(ids[0]),
    measured,
    context.inpaintWindows[index],
  );
  const masthead = ids.some((id) => id.startsWith("qwen-masthead:"));
  const glow =
    masthead ||
    ids.some(
      (id) =>
        id.startsWith("qwen-pigment:") ||
        id.startsWith("qwen-layered-title:") ||
        id.startsWith("qwen-cover-columns:") ||
        id.startsWith("qwen-jacket-promo:"),
    );
  const envelope =
    bounded ||
    illustratedPlateEnvelope(
      measured,
      context.inpaintWindows[index],
      glow ? 56 : kind === "caption" ? 26 : 11,
    );
  return { measured, envelope, masthead };
}

function includeGroupedCaptionPlates(
  context: PatternMaskContext,
  options: GroupedRegionOptions,
) {
  const blocks = new Map(options.page.blocks.map((block) => [block.id, block]));
  for (const [i, ids] of context.inpaintWindowGroupIds.entries()) {
    if (ids.some((id) => id.startsWith("qwen-layered-title:"))) {
      const block = blocks.get(context.validationBlockIds[i]);
      if (!block) continue;
      const measured = measureLayeredTitle(
        options.bitmap,
        options.page,
        bboxToPixelRect(block.bbox, options.page),
      );
      if (measured) context.inpaintWindowMasks[i] = measured;
      continue;
    }
    if (ids.some((id) => id.startsWith("qwen-magazine-credit:"))) {
      context.inpaintWindowMasks[i] = completeMagazineLine(
        options.bitmap,
        options.width,
        options.page.height,
        context.inpaintWindowMasks[i],
      );
      continue;
    }
    if (isIllustratedTitleGroup(ids) !== true) continue;
    const block = blocks.get(context.validationBlockIds[i]);
    if (!block) continue;
    const rect = bboxToPixelRect(block.bbox, options.page);
    const backing = groupedDiamondBacking(
      options.bitmap,
      options.width,
      options.page.height,
      rect,
      context.inpaintWindowMasks[i],
    );
    if (backing)
      context.inpaintWindowMasks[i] = unionWindowMasks(
        context.inpaintWindowMasks[i],
        backing,
      );
  }
}

export function coalesceSharedConstrainedWindows(
  context: SharedConstrainedWindowContext,
) {
  const roots = resolveSharedWindowRoots(context.inpaintWindowGroupIds);
  const windows: PixelRect[] = [];
  const masks: InpaintingWindowMask[] = [];
  const compositeMasks: InpaintingWindowMask[] = [];
  const compositeFeatherPx: number[] = [];
  const constraints: Array<InpaintingWindowMask | null> = [];
  const groupIds: string[][] = [];
  const speechBubbleWindows: boolean[] = [];
  const outputIndexByRoot = new Map<number, number>();
  const originalIndices: number[] = [];
  for (let index = 0; index < context.inpaintWindows.length; index += 1) {
    const entry = readSharedWindowEntry(context, index);
    const root = roots[index] ?? index;
    const outputIndex = outputIndexByRoot.get(root);
    if (outputIndex === undefined) {
      outputIndexByRoot.set(root, windows.length);
      originalIndices.push(index);
      windows.push(entry.window);
      masks.push(entry.mask);
      compositeMasks.push(entry.compositeMask);
      compositeFeatherPx.push(entry.featherPx);
      constraints.push(entry.constraint);
      groupIds.push(entry.groupIds);
      speechBubbleWindows.push(entry.speechBubble);
      continue;
    }
    const existingWindow = windows[outputIndex] as PixelRect;
    speechBubbleWindows[outputIndex] &&= entry.speechBubble;
    const existingMask = masks[outputIndex] as InpaintingWindowMask;
    windows[outputIndex] = unionRects(existingWindow, entry.window);
    masks[outputIndex] = unionWindowMasks(existingMask, entry.mask);
    compositeMasks[outputIndex] = unionWindowMasks(
      compositeMasks[outputIndex] as InpaintingWindowMask,
      entry.compositeMask,
    );
    compositeFeatherPx[outputIndex] = Math.max(
      compositeFeatherPx[outputIndex] ?? 0,
      entry.featherPx,
    );
    constraints[outputIndex] = unionOptionalWindowMasks(
      constraints[outputIndex] ?? null,
      entry.constraint,
    );
    groupIds[outputIndex] = [
      ...new Set([...(groupIds[outputIndex] ?? []), ...entry.groupIds]),
    ];
  }
  context.inpaintWindows = windows;
  context.inpaintWindowMasks = masks;
  context.inpaintCompositeMasks = compositeMasks;
  context.inpaintCompositeFeatherPx = compositeFeatherPx;
  context.inpaintWindowConstraints = constraints;
  context.inpaintWindowGroupIds = groupIds;
  context.inpaintSpeechBubbleWindows = speechBubbleWindows;
  return originalIndices;
}

function readSharedWindowEntry(
  context: SharedConstrainedWindowContext,
  index: number,
): SharedWindowEntry {
  const window = context.inpaintWindows[index];
  const mask = context.inpaintWindowMasks[index];
  const compositeMask = context.inpaintCompositeMasks[index];
  const featherPx = context.inpaintCompositeFeatherPx[index];
  if (!window || !mask || !compositeMask || featherPx === undefined) {
    throw new Error("Inpainting window metadata is incomplete.");
  }
  return {
    compositeMask,
    constraint: context.inpaintWindowConstraints[index] ?? null,
    featherPx,
    groupIds: [...(context.inpaintWindowGroupIds[index] ?? [])],
    mask,
    window,
    speechBubble: context.inpaintSpeechBubbleWindows[index] === true,
  };
}

function resolveSharedWindowRoots(groupIds: readonly string[][]): number[] {
  const parents = groupIds.map((_, index) => index);
  const firstWindowByGroup = new Map<string, number>();
  for (const [index, ids] of groupIds.entries()) {
    for (const id of ids) {
      const firstIndex = firstWindowByGroup.get(id);
      if (firstIndex === undefined) {
        firstWindowByGroup.set(id, index);
      } else {
        joinWindowRoots(parents, firstIndex, index);
      }
    }
  }
  return parents.map((_, index) => findWindowRoot(parents, index));
}

function findWindowRoot(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root] as number;
  let cursor = index;
  while (parents[cursor] !== cursor) {
    const parent = parents[cursor] as number;
    parents[cursor] = root;
    cursor = parent;
  }
  return root;
}

function joinWindowRoots(parents: number[], left: number, right: number): void {
  const leftRoot = findWindowRoot(parents, left);
  const rightRoot = findWindowRoot(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function unionOptionalWindowMasks(
  left: InpaintingWindowMask | null,
  right: InpaintingWindowMask | null,
): InpaintingWindowMask | null {
  if (!left) return right;
  if (!right) return left;
  return unionWindowMasks(left, right);
}

function unionWindowMasks(
  left: InpaintingWindowMask,
  right: InpaintingWindowMask,
): InpaintingWindowMask {
  const bounds = unionRects(left.bounds, right.bounds);
  const data = projectWindowMask(left, bounds);
  projectWindowMask(right, bounds).forEach((on, i) => {
    if (on) data[i] = 1;
  });
  return { bounds, data };
}

function groupedPublisherRows(context: PatternMaskContext, page: MangaPage) {
  const groups = new Map<string, { rect: PixelRect; reading: string }[]>();
  const blocks = new Map(page.blocks.map((b) => [b.id, b]));
  for (const [i, ids] of context.inpaintWindowGroupIds.entries()) {
    const group = ids.find((id) => id.startsWith("qwen-illustrated-title:"));
    const block = blocks.get(context.validationBlockIds[i]);
    if (!group || !block) continue;
    const rows = groups.get(group) ?? [];
    rows.push({
      rect: bboxToPixelRect(block.bbox, page),
      reading: block.sourceText,
    });
    groups.set(group, rows);
  }
  return groups;
}
