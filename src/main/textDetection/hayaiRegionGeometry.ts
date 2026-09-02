/* eslint-disable complexity, max-depth, max-lines, max-lines-per-function -- sealed v11 geometry policy stays auditable in one module */
import type {
  ComicPageDetection,
  ComicPageDetectionResult,
} from "../bubbleLayout/contracts";

const HAYAI_REGION_SCHEMA = "hayai-dialogue-effect-separated-v1" as const;

type PixelBox = [number, number, number, number];

type HayaiRegion = {
  id: number;
  regionId: string;
  kind: "dialogue" | "effect";
  bbox: PixelBox;
  detectorConfidence: number;
  sourceDetectionIds: string[];
};

export type HayaiRegionManifest = {
  schemaVersion: typeof HAYAI_REGION_SCHEMA;
  width: number;
  height: number;
  dialogueRegions: HayaiRegion[];
  effectRegions: HayaiRegion[];
  diagnostics: {
    dialogueOverlapMerges: number;
    dialogueOverlapCuts: number;
    dialogueOwnershipSkips: number;
    rejectedDialogueCount: number;
    effectOverlapMerges: number;
    effectOverlapCuts: number;
    rejectedEffectCount: number;
  };
};

type MaskDetection = {
  detection: ComicPageDetection;
  detectionId: string;
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
  pageWidth: number;
  pageHeight: number;
  maskArea: number;
  maskBox: PixelBox;
  centroid: [number, number];
};

type MutableRegion = Omit<HayaiRegion, "id" | "regionId"> & {
  sourceMasks: Uint8Array[];
  protectedMask: Uint8Array;
  centroid: [number, number];
  maskArea: number;
  ownershipKeys: string[];
};

const MIN_TEXT_CONTAINMENT = 0.55;
const MIN_DUPLICATE_TEXT_MASK_OVERLAP = 0.75;
const MAX_NESTED_DUPLICATE_TEXT_AREA_RATIO = 0.01;
const TEXT_MASK_OUTLIER_TAIL_RATIO = 0.005;
const TEXT_MASK_OUTLIER_MIN_AREA_GAIN = 1.25;
const TEXT_BROAD_SPARSE_MIN_PAGE_AREA = 0.055;
const TEXT_BROAD_SPARSE_MAX_DENSITY = 0.04;
const TEXT_BROAD_SPARSE_MAX_CONTAINER_MASK_SUPPORT = 0.25;
const FX_MAX_GROUP_GAP = 42;
const FX_MIN_GROUP_GAP = 8;
const FX_GAP_SCALE = 0.55;
const FX_MIN_AXIS_OVERLAP = 0.25;
const FX_OVERSIZED_PROPOSAL_SCORE = 0.5;
const FX_TEXT_PRIORITY_BBOX_CONTAINMENT = 0.82;
const FX_TEXT_PRIORITY_MASK_CONTAINMENT = 0.08;
const FX_TEXT_PRIORITY_BBOX_IOU = 0.3;
const FX_BROAD_TEXT_MIN_CONTAINMENT = 0.75;
const FX_BROAD_TEXT_MAX_SCORE = 0.5;
const FX_PANEL_MIN_MASK_CONTAINMENT = 0.35;
const FX_PANEL_MIN_BBOX_CONTAINMENT = 0.5;
const FX_PANEL_MAX_ALIGNED_GAP = 96;
const FX_PANEL_ALIGNED_GAP_SCALE = 1.6;
const FX_PANEL_MIN_ALIGNED_OVERLAP = 0.5;

export function buildHayaiRegionManifest(
  result: ComicPageDetectionResult,
): HayaiRegionManifest {
  const detections = prepareDetections(result);
  const rawText = detections.filter((item) => item.detection.label === "text");
  const bubbles = detections.filter(
    (item) => item.detection.label === "bubble",
  );
  const panels = detections.filter((item) => item.detection.label === "panel");
  const effects = detections.filter(
    (item) => item.detection.label === "onomatopoeia",
  );
  const textResult = rejectBroadSparseText(rawText, bubbles, panels);
  const text = textResult.kept;
  const assignments = assignTextToBubbles(text, bubbles);
  const dialogue = buildDialogueRegions(
    text,
    assignments,
    result.imageWidth,
    result.imageHeight,
  );
  const effectResult = buildEffectRegions(
    effects,
    text,
    panels,
    result.imageWidth,
    result.imageHeight,
  );
  const dialogueRectification = rectifyOverlaps(
    dialogue,
    result.imageWidth,
    result.imageHeight,
    2,
  );
  const effectRectification = rectifyOverlaps(
    effectResult.regions,
    result.imageWidth,
    result.imageHeight,
    0,
  );
  return {
    schemaVersion: HAYAI_REGION_SCHEMA,
    width: result.imageWidth,
    height: result.imageHeight,
    dialogueRegions: finalizeRegions(dialogue, "dialogue"),
    effectRegions: finalizeRegions(effectResult.regions, "effect"),
    diagnostics: {
      dialogueOverlapMerges: dialogueRectification.merges,
      dialogueOverlapCuts: dialogueRectification.cuts,
      dialogueOwnershipSkips: dialogueRectification.ownershipSkips,
      rejectedDialogueCount: textResult.rejected,
      effectOverlapMerges: effectRectification.merges,
      effectOverlapCuts: effectRectification.cuts,
      rejectedEffectCount: effectResult.rejected,
    },
  };
}

function prepareDetections(result: ComicPageDetectionResult): MaskDetection[] {
  return result.detections.flatMap((detection, index) => {
    const source = detection.mask;
    if (!source) return [];
    const mask = new Uint8Array(source.logits.length);
    let area = 0;
    for (let pixel = 0; pixel < source.logits.length; pixel += 1) {
      if ((source.logits[pixel] ?? -1) >= 0) {
        mask[pixel] = 1;
        area += 1;
      }
    }
    const rawGridBox = findMaskBox(mask, source.width, source.height);
    if (!rawGridBox || area === 0) return [];
    const refined =
      detection.label === "text"
        ? trimTextMaskOutliers(mask, source.width, source.height, rawGridBox)
        : { area, box: rawGridBox, mask };
    const gridBox = refined.box;
    area = refined.area;
    const prefix =
      detection.label === "text"
        ? "T"
        : detection.label === "onomatopoeia"
          ? "F"
          : detection.label === "bubble"
            ? "B"
            : "P";
    return [
      {
        detection,
        detectionId: `${prefix}${String(index + 1).padStart(3, "0")}`,
        mask: refined.mask,
        maskWidth: source.width,
        maskHeight: source.height,
        pageWidth: result.imageWidth,
        pageHeight: result.imageHeight,
        maskArea: area,
        maskBox: gridBoxToPageBox(
          gridBox,
          source.width,
          source.height,
          result.imageWidth,
          result.imageHeight,
        ),
        centroid: maskCentroid(
          refined.mask,
          source.width,
          source.height,
          result.imageWidth,
          result.imageHeight,
        ),
      },
    ];
  });
}

function trimTextMaskOutliers(
  source: Uint8Array,
  width: number,
  height: number,
  rawBox: PixelBox,
): { area: number; box: PixelBox; mask: Uint8Array } {
  const robustBox = maskQuantileBox(
    source,
    width,
    height,
    TEXT_MASK_OUTLIER_TAIL_RATIO,
  );
  if (
    !robustBox ||
    boxArea(rawBox) / Math.max(1, boxArea(robustBox)) <
      TEXT_MASK_OUTLIER_MIN_AREA_GAIN
  ) {
    return { area: countMaskPixels(source), box: rawBox, mask: source };
  }
  const mask = new Uint8Array(source);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (
        x < robustBox[0] ||
        x >= robustBox[2] ||
        y < robustBox[1] ||
        y >= robustBox[3]
      ) {
        mask[y * width + x] = 0;
      }
    }
  }
  return {
    area: countMaskPixels(mask),
    box: robustBox,
    mask,
  };
}

function maskQuantileBox(
  mask: Uint8Array,
  width: number,
  height: number,
  tailRatio: number,
): PixelBox | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length === 0) return null;
  xs.sort((left, right) => left - right);
  ys.sort((left, right) => left - right);
  const lowIndex = Math.floor((xs.length - 1) * tailRatio);
  const highIndex = Math.floor((xs.length - 1) * (1 - tailRatio));
  return [
    xs[lowIndex] ?? 0,
    ys[lowIndex] ?? 0,
    (xs[highIndex] ?? width - 1) + 1,
    (ys[highIndex] ?? height - 1) + 1,
  ];
}

function countMaskPixels(mask: Uint8Array): number {
  return mask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
}

function rejectBroadSparseText(
  text: MaskDetection[],
  bubbles: MaskDetection[],
  panels: MaskDetection[],
): { kept: MaskDetection[]; rejected: number } {
  const containers = [...bubbles, ...panels];
  const kept: MaskDetection[] = [];
  let rejected = 0;
  for (const item of text) {
    const pageArea = Math.max(1, item.pageWidth * item.pageHeight);
    const areaFraction = boxArea(item.maskBox) / pageArea;
    const density =
      item.maskArea /
      Math.max(
        1,
        boxAreaInGrid(item.maskBox, item, item.pageWidth, item.pageHeight),
      );
    const containerSupport = Math.max(
      0,
      ...containers.map((container) => maskContainment(item, container)),
    );
    if (
      areaFraction >= TEXT_BROAD_SPARSE_MIN_PAGE_AREA &&
      density <= TEXT_BROAD_SPARSE_MAX_DENSITY &&
      containerSupport < TEXT_BROAD_SPARSE_MAX_CONTAINER_MASK_SUPPORT
    ) {
      rejected += 1;
      continue;
    }
    kept.push(item);
  }
  return { kept, rejected };
}

function assignTextToBubbles(
  text: MaskDetection[],
  bubbles: MaskDetection[],
): Map<MaskDetection, MaskDetection> {
  const assignments = new Map<MaskDetection, MaskDetection>();
  for (const item of text) {
    let best: { bubble: MaskDetection; support: number } | null = null;
    for (const bubble of bubbles) {
      const containment = maskContainment(item, bubble);
      const boxContainment = boxIntersectionOverSubject(
        item.maskBox,
        bubble.maskBox,
      );
      const centered = centerInMask(bubble, item.maskBox);
      const support = Math.max(
        containment,
        boxContainment * (centered ? 0.92 : 0.65),
      );
      const eligible =
        containment >= MIN_TEXT_CONTAINMENT ||
        (centered && boxContainment >= 0.6);
      if (
        eligible &&
        (!best ||
          support > best.support ||
          (support === best.support &&
            bubble.detection.score > best.bubble.detection.score))
      ) {
        best = { bubble, support };
      }
    }
    if (best) assignments.set(item, best.bubble);
  }
  return assignments;
}

function buildDialogueRegions(
  text: MaskDetection[],
  assignments: Map<MaskDetection, MaskDetection>,
  width: number,
  height: number,
): MutableRegion[] {
  const ownershipByText = new Map(
    text.map((item) => [
      item,
      assignments.get(item)?.detectionId ?? `free:${item.detectionId}`,
    ]),
  );
  const groups = new DisjointSet(text.length);
  for (let left = 0; left < text.length; left += 1) {
    for (let right = left + 1; right < text.length; right += 1) {
      const sameBubble =
        assignments.has(text[left]) &&
        assignments.get(text[left]) === assignments.get(text[right]);
      const bothUncontained =
        !assignments.has(text[left]) && !assignments.has(text[right]);
      if (!sameBubble && !bothUncontained) continue;
      if (isDuplicateText(text[left], text[right], bothUncontained)) {
        groups.union(left, right);
      }
    }
  }
  const membersByRoot = new Map<number, MaskDetection[]>();
  text.forEach((item, index) => {
    const root = groups.find(index);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), item]);
  });
  return [...membersByRoot.values()].map((members) =>
    createRegion(
      members,
      "dialogue",
      width,
      height,
      5,
      members.map(
        (member) => ownershipByText.get(member) ?? `free:${member.detectionId}`,
      ),
    ),
  );
}

function isDuplicateText(
  first: MaskDetection,
  second: MaskDetection,
  uncontained: boolean,
): boolean {
  const intersection = maskIntersection(first, second);
  const smallerMask = Math.max(1, Math.min(first.maskArea, second.maskArea));
  const maskOverlap = intersection / smallerMask;
  const smallerBox = Math.max(
    1,
    Math.min(boxArea(first.maskBox), boxArea(second.maskBox)),
  );
  const boxContainment =
    boxIntersection(first.maskBox, second.maskBox) / smallerBox;
  const areaRatio =
    smallerBox /
    Math.max(1, Math.max(boxArea(first.maskBox), boxArea(second.maskBox)));
  if (
    bboxIou(first.maskBox, second.maskBox) >= 0.65 &&
    maskOverlap >= MIN_DUPLICATE_TEXT_MASK_OVERLAP
  ) {
    return true;
  }
  // Koharu sometimes emits a composite text mask plus a nearly identical
  // child whose box protrudes by one grid cell.  The protrusion can drop both
  // IoU and strict containment even though almost every child mask pixel is
  // already represented by the composite.  Treat that strong mask evidence
  // as a duplicate without reviving bbox-only nested suppression.
  if (boxContainment >= 0.8 && maskOverlap >= 0.9) {
    return true;
  }
  if (
    boxContainment >= 0.95 &&
    areaRatio <= MAX_NESTED_DUPLICATE_TEXT_AREA_RATIO &&
    maskOverlap >= 0.25
  ) {
    return true;
  }
  return (
    uncontained &&
    boxContainment >= 0.9 &&
    maskOverlap >= MIN_DUPLICATE_TEXT_MASK_OVERLAP
  );
}

function buildEffectRegions(
  effects: MaskDetection[],
  text: MaskDetection[],
  panels: MaskDetection[],
  width: number,
  height: number,
): { regions: MutableRegion[]; rejected: number } {
  const candidates = [...effects].sort(
    (left, right) => right.detection.score - left.detection.score,
  );
  const kept: MaskDetection[] = [];
  let rejected = 0;
  for (const candidate of candidates) {
    const candidateWidth = candidate.maskBox[2] - candidate.maskBox[0];
    const candidateHeight = candidate.maskBox[3] - candidate.maskBox[1];
    const oversizedStrip =
      candidateHeight / height >= 0.45 &&
      candidateWidth / width <= 0.35 &&
      candidate.detection.score < FX_OVERSIZED_PROPOSAL_SCORE;
    const enclosedTextCount = text.filter(
      (item) =>
        boxIntersectionOverSubject(item.maskBox, candidate.maskBox) >=
        FX_BROAD_TEXT_MIN_CONTAINMENT,
    ).length;
    if (
      oversizedStrip ||
      (candidate.detection.score < FX_BROAD_TEXT_MAX_SCORE &&
        enclosedTextCount >= 2) ||
      text.some((item) => effectDuplicatesText(candidate, item)) ||
      kept.some((item) => isDuplicateEffect(candidate, item))
    ) {
      rejected += 1;
      continue;
    }
    kept.push(candidate);
  }
  const panelByPiece = new Map(
    kept.map((piece) => [piece, owningPanelId(piece, panels)]),
  );
  const groups = new DisjointSet(kept.length);
  for (let left = 0; left < kept.length; left += 1) {
    for (let right = left + 1; right < kept.length; right += 1) {
      if (panelByPiece.get(kept[left]) !== panelByPiece.get(kept[right])) {
        continue;
      }
      if (
        shouldGroupEffects(
          kept[left],
          kept[right],
          panelByPiece.get(kept[left]),
        )
      ) {
        groups.union(left, right);
      }
    }
  }
  const membersByRoot = new Map<number, MaskDetection[]>();
  kept.forEach((item, index) => {
    const root = groups.find(index);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), item]);
  });
  const padding = Math.min(12, Math.max(3, Math.min(width, height) * 0.006));
  const regions = [...membersByRoot.values()].flatMap((members) => {
    const union = unionBoxes(members.map((item) => item.maskBox));
    const maskArea = members.reduce((sum, item) => sum + item.maskArea, 0);
    const areaFraction = boxArea(union) / Math.max(1, width * height);
    const density =
      maskArea / Math.max(1, boxAreaInGrid(union, members[0], width, height));
    if (
      members.length === 1 &&
      areaFraction >= 0.18 &&
      density <= 0.18 &&
      members[0].detection.score < 0.5
    ) {
      rejected += 1;
      return [];
    }
    return [createRegion(members, "effect", width, height, padding)];
  });
  return { regions, rejected };
}

function effectDuplicatesText(
  effect: MaskDetection,
  text: MaskDetection,
): boolean {
  const boxContainment = boxIntersectionOverSubject(
    effect.maskBox,
    text.maskBox,
  );
  const maskSupport = maskContainment(effect, text);
  return (
    (bboxIou(effect.maskBox, text.maskBox) >= 0.65 && maskSupport >= 0.75) ||
    (boxContainment >= FX_TEXT_PRIORITY_BBOX_CONTAINMENT &&
      (maskSupport >= FX_TEXT_PRIORITY_MASK_CONTAINMENT ||
        bboxIou(effect.maskBox, text.maskBox) >= FX_TEXT_PRIORITY_BBOX_IOU))
  );
}

function isDuplicateEffect(
  candidate: MaskDetection,
  existing: MaskDetection,
): boolean {
  const containment = boxIntersectionOverSubject(
    candidate.maskBox,
    existing.maskBox,
  );
  const reverseContainment = boxIntersectionOverSubject(
    existing.maskBox,
    candidate.maskBox,
  );
  const maskSupport = maskContainment(candidate, existing);
  const reverseMaskSupport = maskContainment(existing, candidate);
  return (
    (containment >= 0.72 && maskSupport >= 0.42) ||
    (Math.max(containment, reverseContainment) >= 0.9 &&
      bboxIou(candidate.maskBox, existing.maskBox) >= 0.45) ||
    (reverseContainment >= 0.9 &&
      reverseMaskSupport >= 0.55 &&
      candidate.detection.score <= existing.detection.score)
  );
}

function owningPanelId(
  piece: MaskDetection,
  panels: MaskDetection[],
): string | null {
  let best: { id: string; support: number; score: number } | null = null;
  for (const panel of panels) {
    const maskSupport = maskContainment(piece, panel);
    const boxSupport = boxIntersectionOverSubject(piece.maskBox, panel.maskBox);
    const centered = centerInMask(panel, piece.maskBox);
    if (
      maskSupport < FX_PANEL_MIN_MASK_CONTAINMENT &&
      boxSupport < FX_PANEL_MIN_BBOX_CONTAINMENT &&
      !(centered && boxSupport >= 0.35)
    ) {
      continue;
    }
    const support = Math.max(
      maskSupport,
      boxSupport * (centered ? 0.95 : 0.75),
    );
    if (
      !best ||
      support > best.support ||
      (support === best.support && panel.detection.score > best.score)
    ) {
      best = { id: panel.detectionId, support, score: panel.detection.score };
    }
  }
  return best?.id ?? null;
}

function shouldGroupEffects(
  first: MaskDetection,
  second: MaskDetection,
  panelId: string | null | undefined,
): boolean {
  const firstWidth = first.maskBox[2] - first.maskBox[0];
  const firstHeight = first.maskBox[3] - first.maskBox[1];
  const secondWidth = second.maskBox[2] - second.maskBox[0];
  const secondHeight = second.maskBox[3] - second.maskBox[1];
  const firstAspect = firstWidth / Math.max(1, firstHeight);
  const secondAspect = secondWidth / Math.max(1, secondHeight);
  if (
    (firstAspect >= 2 && secondAspect <= 0.5) ||
    (secondAspect >= 2 && firstAspect <= 0.5)
  ) {
    return false;
  }
  const horizontalGap = axisGap(
    first.maskBox[0],
    first.maskBox[2],
    second.maskBox[0],
    second.maskBox[2],
  );
  const verticalGap = axisGap(
    first.maskBox[1],
    first.maskBox[3],
    second.maskBox[1],
    second.maskBox[3],
  );
  const horizontalOverlap = axisOverlap(
    first.maskBox[0],
    first.maskBox[2],
    second.maskBox[0],
    second.maskBox[2],
  );
  const verticalOverlap = axisOverlap(
    first.maskBox[1],
    first.maskBox[3],
    second.maskBox[1],
    second.maskBox[3],
  );
  let horizontalLimit = Math.min(
    FX_MAX_GROUP_GAP,
    Math.max(
      FX_MIN_GROUP_GAP,
      FX_GAP_SCALE * Math.min(firstHeight, secondHeight),
    ),
  );
  let verticalLimit = Math.min(
    FX_MAX_GROUP_GAP,
    Math.max(
      FX_MIN_GROUP_GAP,
      FX_GAP_SCALE * Math.min(firstWidth, secondWidth),
    ),
  );
  let horizontal =
    horizontalGap <= horizontalLimit && verticalOverlap >= FX_MIN_AXIS_OVERLAP;
  let vertical =
    verticalGap <= verticalLimit && horizontalOverlap >= FX_MIN_AXIS_OVERLAP;
  const scaleRatio =
    Math.min(firstWidth * firstHeight, secondWidth * secondHeight) /
    Math.max(1, Math.max(firstWidth * firstHeight, secondWidth * secondHeight));
  if (panelId && scaleRatio >= 0.35) {
    horizontalLimit = Math.min(
      FX_PANEL_MAX_ALIGNED_GAP,
      FX_PANEL_ALIGNED_GAP_SCALE * Math.min(firstHeight, secondHeight),
    );
    verticalLimit = Math.min(
      FX_PANEL_MAX_ALIGNED_GAP,
      FX_PANEL_ALIGNED_GAP_SCALE * Math.min(firstWidth, secondWidth),
    );
    horizontal ||=
      horizontalGap <= horizontalLimit &&
      verticalOverlap >= FX_PANEL_MIN_ALIGNED_OVERLAP;
    vertical ||=
      verticalGap <= verticalLimit &&
      horizontalOverlap >= FX_PANEL_MIN_ALIGNED_OVERLAP;
  }
  return horizontal || vertical;
}

function createRegion(
  members: MaskDetection[],
  kind: "dialogue" | "effect",
  width: number,
  height: number,
  padding: number,
  ownershipKeys: readonly string[] = [],
): MutableRegion {
  const maskArea = members.reduce((sum, member) => sum + member.maskArea, 0);
  const centroid: [number, number] = [
    members.reduce(
      (sum, member) => sum + member.centroid[0] * member.maskArea,
      0,
    ) / Math.max(1, maskArea),
    members.reduce(
      (sum, member) => sum + member.centroid[1] * member.maskArea,
      0,
    ) / Math.max(1, maskArea),
  ];
  const sourceMasks = members.map((member) => member.mask);
  const protectedMask = dilateMask(
    unionMasks(sourceMasks),
    members[0].maskWidth,
    members[0].maskHeight,
    1,
  );
  return {
    kind,
    bbox: padBox(
      unionBoxes(members.map((member) => member.maskBox)),
      width,
      height,
      padding,
    ),
    detectorConfidence: Math.max(
      ...members.map((member) => member.detection.score),
    ),
    sourceDetectionIds: members.map((member) => member.detectionId),
    sourceMasks,
    protectedMask,
    centroid,
    maskArea,
    ownershipKeys: [...new Set(ownershipKeys)],
  };
}

function rectifyOverlaps(
  regions: MutableRegion[],
  width: number,
  height: number,
  separationMargin: number,
): { cuts: number; merges: number; ownershipSkips: number } {
  let cuts = 0;
  let merges = 0;
  const ownershipSkips = new Set<string>();
  for (let pass = 0; pass < 500; pass += 1) {
    let changed = false;
    outer: for (let left = 0; left < regions.length; left += 1) {
      for (let right = left + 1; right < regions.length; right += 1) {
        if (boxIntersection(regions[left].bbox, regions[right].bbox) <= 0)
          continue;
        const cut = findLosslessCut(
          regions[left],
          regions[right],
          width,
          height,
          separationMargin,
        );
        if (cut) {
          regions[left].bbox = cut.first;
          regions[right].bbox = cut.second;
          cuts += 1;
        } else if (
          hasConflictingDialogueOwnership(regions[left], regions[right])
        ) {
          ownershipSkips.add(
            [
              [...regions[left].sourceDetectionIds].sort().join("+"),
              [...regions[right].sourceDetectionIds].sort().join("+"),
            ]
              .sort()
              .join("|"),
          );
          continue;
        } else {
          regions[left] = mergeRegions(regions[left], regions[right]);
          regions.splice(right, 1);
          merges += 1;
        }
        changed = true;
        break outer;
      }
    }
    if (!changed) break;
  }
  return { cuts, merges, ownershipSkips: ownershipSkips.size };
}

function hasConflictingDialogueOwnership(
  first: MutableRegion,
  second: MutableRegion,
): boolean {
  return (
    first.kind === "dialogue" &&
    second.kind === "dialogue" &&
    first.ownershipKeys.length > 0 &&
    second.ownershipKeys.length > 0 &&
    !first.ownershipKeys.some((key) => second.ownershipKeys.includes(key))
  );
}

function findLosslessCut(
  first: MutableRegion,
  second: MutableRegion,
  width: number,
  height: number,
  separationMargin: number,
): { first: PixelBox; second: PixelBox } | null {
  const candidates: Array<{
    score: [number, number, number];
    first: PixelBox;
    second: PixelBox;
  }> = [];
  for (const axis of [0, 1] as const) {
    const low = axis;
    const high = axis + 2;
    const firstAnchor = first.centroid[axis];
    const secondAnchor = second.centroid[axis];
    if (Math.abs(firstAnchor - secondAnchor) < 0.01) continue;
    const firstIsLower = firstAnchor < secondAnchor;
    const lower = firstIsLower ? first.bbox : second.bbox;
    const upper = firstIsLower ? second.bbox : first.bbox;
    const overlapLow = Math.max(lower[low], upper[low]);
    const overlapHigh = Math.min(lower[high], upper[high]);
    if (overlapHigh <= overlapLow) continue;
    const halfMargin = separationMargin / 2;
    for (
      let coordinate = Math.ceil(overlapLow * 2) / 2;
      coordinate <= overlapHigh;
      coordinate += 0.5
    ) {
      const proposedLower = [...lower] as PixelBox;
      const proposedUpper = [...upper] as PixelBox;
      proposedLower[high] = Math.min(
        proposedLower[high],
        coordinate - halfMargin,
      );
      proposedUpper[low] = Math.max(
        proposedUpper[low],
        coordinate + halfMargin,
      );
      if (
        proposedLower[high] <= proposedLower[low] ||
        proposedUpper[high] <= proposedUpper[low] ||
        Math.min(firstAnchor, secondAnchor) >= proposedLower[high] ||
        Math.max(firstAnchor, secondAnchor) < proposedUpper[low]
      )
        continue;
      const proposedFirst = firstIsLower ? proposedLower : proposedUpper;
      const proposedSecond = firstIsLower ? proposedUpper : proposedLower;
      if (
        !allProtectedPixelsRetained(
          first,
          second,
          proposedFirst,
          proposedSecond,
          width,
          height,
        )
      )
        continue;
      const firstRetention = maskRetention(
        first.sourceMasks,
        proposedFirst,
        width,
        height,
      );
      const secondRetention = maskRetention(
        second.sourceMasks,
        proposedSecond,
        width,
        height,
      );
      const oldArea = boxArea(first.bbox) + boxArea(second.bbox);
      const newArea = boxArea(proposedFirst) + boxArea(proposedSecond);
      candidates.push({
        score: [
          -Math.min(firstRetention, secondRetention),
          Math.max(0, oldArea - newArea),
          Math.abs(coordinate - (firstAnchor + secondAnchor) / 2),
        ],
        first: proposedFirst,
        second: proposedSecond,
      });
    }
  }
  candidates.sort((left, right) => compareTuple(left.score, right.score));
  return candidates[0] ?? null;
}

function allProtectedPixelsRetained(
  first: MutableRegion,
  second: MutableRegion,
  firstBox: PixelBox,
  secondBox: PixelBox,
  width: number,
  height: number,
): boolean {
  const protectedMask = unionMasks([first.protectedMask, second.protectedMask]);
  const maskWidth = Math.round(Math.sqrt(protectedMask.length));
  const maskHeight = protectedMask.length / maskWidth;
  for (let index = 0; index < protectedMask.length; index += 1) {
    if (!protectedMask[index]) continue;
    const x = ((index % maskWidth) + 0.5) * (width / maskWidth);
    const y = (Math.floor(index / maskWidth) + 0.5) * (height / maskHeight);
    if (!pointInBox(x, y, firstBox) && !pointInBox(x, y, secondBox))
      return false;
  }
  return true;
}

function maskRetention(
  masks: Uint8Array[],
  box: PixelBox,
  width: number,
  height: number,
): number {
  const mask = unionMasks(masks);
  const maskWidth = Math.round(Math.sqrt(mask.length));
  const maskHeight = mask.length / maskWidth;
  let total = 0;
  let retained = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    total += 1;
    const x = ((index % maskWidth) + 0.5) * (width / maskWidth);
    const y = (Math.floor(index / maskWidth) + 0.5) * (height / maskHeight);
    if (pointInBox(x, y, box)) retained += 1;
  }
  return retained / Math.max(1, total);
}

function mergeRegions(
  first: MutableRegion,
  second: MutableRegion,
): MutableRegion {
  const area = first.maskArea + second.maskArea;
  const sourceMasks = [...first.sourceMasks, ...second.sourceMasks];
  const protectedMask = unionMasks([first.protectedMask, second.protectedMask]);
  return {
    kind: first.kind,
    bbox: unionBoxes([first.bbox, second.bbox]),
    detectorConfidence: Math.max(
      first.detectorConfidence,
      second.detectorConfidence,
    ),
    sourceDetectionIds: [
      ...first.sourceDetectionIds,
      ...second.sourceDetectionIds,
    ],
    sourceMasks,
    protectedMask,
    centroid: [
      (first.centroid[0] * first.maskArea +
        second.centroid[0] * second.maskArea) /
        Math.max(1, area),
      (first.centroid[1] * first.maskArea +
        second.centroid[1] * second.maskArea) /
        Math.max(1, area),
    ],
    maskArea: area,
    ownershipKeys: [
      ...new Set([...first.ownershipKeys, ...second.ownershipKeys]),
    ],
  };
}

function finalizeRegions(
  regions: MutableRegion[],
  kind: "dialogue" | "effect",
): HayaiRegion[] {
  return [...regions]
    .sort(
      (left, right) =>
        left.bbox[1] - right.bbox[1] || right.bbox[2] - left.bbox[2],
    )
    .map((region, index) => ({
      id: index + 1,
      regionId: `${kind === "dialogue" ? "D" : "FX"}${String(index + 1).padStart(3, "0")}`,
      kind,
      bbox: region.bbox.map(
        (value) => Math.round(value * 1000) / 1000,
      ) as PixelBox,
      detectorConfidence:
        Math.round(region.detectorConfidence * 1_000_000) / 1_000_000,
      sourceDetectionIds: region.sourceDetectionIds,
    }));
}

class DisjointSet {
  private readonly parents: number[];
  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_unused, index) => index);
  }
  find(value: number): number {
    const parent = this.parents[value];
    if (parent !== value) this.parents[value] = this.find(parent);
    return this.parents[value];
  }
  union(first: number, second: number): void {
    const left = this.find(first);
    const right = this.find(second);
    if (left !== right)
      this.parents[Math.max(left, right)] = Math.min(left, right);
  }
}

function maskContainment(
  subject: MaskDetection,
  container: MaskDetection,
): number {
  return maskIntersection(subject, container) / Math.max(1, subject.maskArea);
}

function maskIntersection(first: MaskDetection, second: MaskDetection): number {
  let count = 0;
  for (let index = 0; index < first.mask.length; index += 1) {
    if (first.mask[index] && second.mask[index]) count += 1;
  }
  return count;
}

function centerInMask(container: MaskDetection, subjectBox: PixelBox): boolean {
  const x = (subjectBox[0] + subjectBox[2]) / 2;
  const y = (subjectBox[1] + subjectBox[3]) / 2;
  const maskX = Math.max(
    0,
    Math.min(
      container.maskWidth - 1,
      Math.floor((x / container.pageWidth) * container.maskWidth),
    ),
  );
  const maskY = Math.max(
    0,
    Math.min(
      container.maskHeight - 1,
      Math.floor((y / container.pageHeight) * container.maskHeight),
    ),
  );
  return Boolean(container.mask[maskY * container.maskWidth + maskX]);
}

function findMaskBox(
  mask: Uint8Array,
  width: number,
  height: number,
): PixelBox | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return right < left ? null : [left, top, right + 1, bottom + 1];
}

function gridBoxToPageBox(
  box: PixelBox,
  maskWidth: number,
  maskHeight: number,
  width: number,
  height: number,
): PixelBox {
  return [
    (box[0] / maskWidth) * width,
    (box[1] / maskHeight) * height,
    (box[2] / maskWidth) * width,
    (box[3] / maskHeight) * height,
  ];
}

function maskCentroid(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  width: number,
  height: number,
): [number, number] {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    sumX += index % maskWidth;
    sumY += Math.floor(index / maskWidth);
    count += 1;
  }
  return [
    ((sumX / Math.max(1, count) + 0.5) / maskWidth) * width,
    ((sumY / Math.max(1, count) + 0.5) / maskHeight) * height,
  ];
}

function unionMasks(masks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(masks[0]?.length ?? 0);
  for (const mask of masks) {
    for (let index = 0; index < output.length; index += 1) {
      if (mask[index]) output[index] = 1;
    }
  }
  return output;
}

function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  iterations: number,
): Uint8Array {
  let current = mask;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = current.slice();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!current[index]) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const px = x + dx;
            const py = y + dy;
            if (px >= 0 && py >= 0 && px < width && py < height)
              next[py * width + px] = 1;
          }
        }
      }
    }
    current = next;
  }
  return current;
}

function boxIntersection(first: PixelBox, second: PixelBox): number {
  return (
    Math.max(0, Math.min(first[2], second[2]) - Math.max(first[0], second[0])) *
    Math.max(0, Math.min(first[3], second[3]) - Math.max(first[1], second[1]))
  );
}

function boxIntersectionOverSubject(
  subject: PixelBox,
  container: PixelBox,
): number {
  return boxIntersection(subject, container) / Math.max(1, boxArea(subject));
}

function bboxIou(first: PixelBox, second: PixelBox): number {
  const intersection = boxIntersection(first, second);
  return (
    intersection / Math.max(1, boxArea(first) + boxArea(second) - intersection)
  );
}

function boxArea(box: PixelBox): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function boxAreaInGrid(
  box: PixelBox,
  detection: MaskDetection,
  width: number,
  height: number,
): number {
  return (
    boxArea(box) *
    (detection.maskWidth / width) *
    (detection.maskHeight / height)
  );
}

function unionBoxes(boxes: PixelBox[]): PixelBox {
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

function padBox(
  box: PixelBox,
  width: number,
  height: number,
  padding: number,
): PixelBox {
  return [
    Math.max(0, box[0] - padding),
    Math.max(0, box[1] - padding),
    Math.min(width, box[2] + padding),
    Math.min(height, box[3] + padding),
  ];
}

function axisGap(
  firstLow: number,
  firstHigh: number,
  secondLow: number,
  secondHigh: number,
): number {
  return Math.max(
    0,
    Math.max(firstLow, secondLow) - Math.min(firstHigh, secondHigh),
  );
}

function axisOverlap(
  firstLow: number,
  firstHigh: number,
  secondLow: number,
  secondHigh: number,
): number {
  const overlap = Math.max(
    0,
    Math.min(firstHigh, secondHigh) - Math.max(firstLow, secondLow),
  );
  return (
    overlap /
    Math.max(1, Math.min(firstHigh - firstLow, secondHigh - secondLow))
  );
}

function pointInBox(x: number, y: number, box: PixelBox): boolean {
  return x >= box[0] && y >= box[1] && x < box[2] && y < box[3];
}

function compareTuple(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
