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
  recognitionBboxes?: PixelBox[];
  sourceDetectionIds: string[];
};

export type HayaiRegionManifest = {
  schemaVersion: typeof HAYAI_REGION_SCHEMA;
  width: number;
  height: number;
  dialogueRegions: HayaiRegion[];
  effectRegions: HayaiRegion[];
  diagnostics: {
    dialogueFragmentMerges: number;
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
  recognitionBboxes: PixelBox[];
};

type TextFragmentPair = readonly [string, string];

const MIN_TEXT_CONTAINMENT = 0.55;
const MIN_DUPLICATE_TEXT_MASK_OVERLAP = 0.75;
// Experiment 4: a composite detector proposal can cover two child proposals
// while landing just below the old 0.90 protruding-child cutoff for one of
// them.  This remains mask-duplication evidence, not a proximity merge.
const PROTRUDING_CHILD_MIN_MASK_OVERLAP = 0.85;
const MAX_NESTED_DUPLICATE_TEXT_AREA_RATIO = 0.01;
const TEXT_MASK_OUTLIER_TAIL_RATIO = 0.005;
const TEXT_MASK_OUTLIER_MIN_AREA_GAIN = 1.25;
const TEXT_UNSUPPORTED_TAIL_MIN_GAP_RATIO = 0.02;
const TEXT_UNSUPPORTED_TAIL_MAX_AREA_RATIO = 0.01;
const TEXT_UNSUPPORTED_TAIL_MIN_AREA_GAIN = 1.15;
const TEXT_UNSUPPORTED_TAIL_MIN_BODY_BOX_SUPPORT = 0.85;
const TEXT_UNSUPPORTED_TAIL_MAX_TAIL_BOX_SUPPORT = 0.1;
const TEXT_BORROWED_TAIL_MIN_GAP_RATIO = 0.02;
const TEXT_BORROWED_TAIL_MAX_AREA_RATIO = 0.08;
const TEXT_BORROWED_TAIL_MIN_OWNER_SCORE = 0.75;
const TEXT_BORROWED_TAIL_MIN_SUBJECT_SCORE = 0.85;
const TEXT_BORROWED_TAIL_MIN_OWNERSHIP = 0.9;
const TEXT_BORROWED_TAIL_MAX_BODY_OVERLAP = 0.1;
const TEXT_DETECTOR_OWNED_TAIL_MIN_SUBJECT_SCORE = 0.8;
const TEXT_DETECTOR_OWNED_TAIL_MAX_AREA_RATIO = 0.2;
const TEXT_DETECTOR_OWNED_TAIL_MIN_BODY_SUPPORT = 0.85;
const TEXT_DETECTOR_OWNED_TAIL_MIN_PEER_SUPPORT = 0.9;
const TEXT_DETECTOR_OWNED_TAIL_MAX_SUBJECT_SUPPORT = 0.1;
const TEXT_DETECTOR_OWNED_TAIL_MIN_BOX_GAP_GRID = 2;
const TEXT_COMPOSITE_CHILD_MIN_SUBJECT_COVERAGE = 0.9;
const TEXT_COMPOSITE_CHILD_MIN_CHILD_COVERAGE = 0.4;
const TEXT_COMPOSITE_CHILD_MIN_CONTRIBUTION = 0.15;
const TEXT_COMPOSITE_CHILD_MAX_PEER_OVERLAP = 0.05;
const TEXT_COMPOSITE_CHILD_MIN_GAP_GRID = 3;
const TEXT_BROAD_SPARSE_MIN_PAGE_AREA = 0.055;
const TEXT_BROAD_SPARSE_MAX_DENSITY = 0.04;
const TEXT_BROAD_SPARSE_MAX_CONTAINER_MASK_SUPPORT = 0.25;
const TEXT_VERTICAL_STRIP_MIN_PAGE_HEIGHT = 0.4;
const TEXT_VERTICAL_STRIP_MIN_ASPECT_RATIO = 12;
const TEXT_VERTICAL_STRIP_TAIL_MIN_GAP_RATIO = 0.04;
const TEXT_VERTICAL_STRIP_TAIL_MAX_AREA_RATIO = 0.08;
const TEXT_FRAGMENT_MIN_SCORE = 0.85;
const TEXT_FRAGMENT_MIN_MASK_AREA_RATIO = 0.15;
const TEXT_FRAGMENT_MAX_MASK_OVERLAP = 0.25;
const TEXT_FRAGMENT_MIN_CROSS_AXIS_OVERLAP = 0.95;
const TEXT_FRAGMENT_MIN_PRIMARY_AXIS_SEPARATION = 0.35;
// Experiment 2: every formerly accepted fragment rejoin that the user
// directly reviewed was either rejected or neutral. Keep the detector pieces
// independent while the sole positive merge anchor is modeled separately.
const TEXT_FRAGMENT_REJOIN_ENABLED = false;
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
  const rawText = trimBorrowedTextMaskTails(
    detections.filter((item) => item.detection.label === "text"),
  );
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
  const dialogueText = isolateDisjointChildCompositeMasks(text, assignments);
  const dialogueAssignments = new Map<MaskDetection, MaskDetection>();
  dialogueText.forEach((item, index) => {
    const bubble = assignments.get(text[index]);
    if (bubble) dialogueAssignments.set(item, bubble);
  });
  const dialogueResult = buildDialogueRegions(
    dialogueText,
    dialogueAssignments,
    result.imageWidth,
    result.imageHeight,
  );
  const dialogue = dialogueResult.regions;
  const effectResult = buildEffectRegions(
    effects,
    dialogueText,
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
  const dialogueFragmentMerges = mergeDialogueFragments(
    dialogue,
    TEXT_FRAGMENT_REJOIN_ENABLED ? dialogueResult.fragmentPairs : [],
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
      dialogueFragmentMerges,
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

function isolateDisjointChildCompositeMasks(
  text: MaskDetection[],
  assignments: Map<MaskDetection, MaskDetection>,
): MaskDetection[] {
  const duplicateGroups = new DisjointSet(text.length);
  for (let left = 0; left < text.length; left += 1) {
    for (let right = left + 1; right < text.length; right += 1) {
      const sameBubble =
        assignments.has(text[left]) &&
        assignments.get(text[left]) === assignments.get(text[right]);
      const bothUncontained =
        !assignments.has(text[left]) && !assignments.has(text[right]);
      if (
        (sameBubble || bothUncontained) &&
        isDuplicateText(text[left], text[right], bothUncontained)
      ) {
        duplicateGroups.union(left, right);
      }
    }
  }
  return text.map((subject, subjectIndex) => {
    const subjectRoot = duplicateGroups.find(subjectIndex);
    const subjectGridBox = findMaskBox(
      subject.mask,
      subject.maskWidth,
      subject.maskHeight,
    );
    if (!subjectGridBox) return subject;
    let best: {
      axis: 0 | 1;
      before: number;
      after: number;
      keepLow: boolean;
      coverage: number;
    } | null = null;
    for (let left = 0; left < text.length; left += 1) {
      const first = text[left];
      if (first === subject || first.maskArea >= subject.maskArea) continue;
      for (let right = left + 1; right < text.length; right += 1) {
        const second = text[right];
        if (second === subject || second.maskArea >= subject.maskArea) continue;
        const firstRoot = duplicateGroups.find(left);
        const secondRoot = duplicateGroups.find(right);
        if (firstRoot === secondRoot) continue;
        const subjectWithFirst = subjectRoot === firstRoot;
        const subjectWithSecond = subjectRoot === secondRoot;
        if (subjectWithFirst === subjectWithSecond) continue;
        const firstGridBox = findMaskBox(
          first.mask,
          first.maskWidth,
          first.maskHeight,
        );
        const secondGridBox = findMaskBox(
          second.mask,
          second.maskWidth,
          second.maskHeight,
        );
        if (!firstGridBox || !secondGridBox) continue;
        const xGap = axisGap(
          firstGridBox[0],
          firstGridBox[2],
          secondGridBox[0],
          secondGridBox[2],
        );
        const yGap = axisGap(
          firstGridBox[1],
          firstGridBox[3],
          secondGridBox[1],
          secondGridBox[3],
        );
        const axis: 0 | 1 = xGap >= yGap ? 0 : 1;
        if (Math.max(xGap, yGap) < TEXT_COMPOSITE_CHILD_MIN_GAP_GRID) {
          continue;
        }
        const peerIntersection = maskIntersection(first, second);
        if (
          peerIntersection /
            Math.max(1, Math.min(first.maskArea, second.maskArea)) >
          TEXT_COMPOSITE_CHILD_MAX_PEER_OVERLAP
        ) {
          continue;
        }
        let firstIntersection = 0;
        let secondIntersection = 0;
        let subjectCovered = 0;
        for (let index = 0; index < subject.mask.length; index += 1) {
          if (!subject.mask[index]) continue;
          const inFirst = Boolean(first.mask[index]);
          const inSecond = Boolean(second.mask[index]);
          if (inFirst) firstIntersection += 1;
          if (inSecond) secondIntersection += 1;
          if (inFirst || inSecond) subjectCovered += 1;
        }
        const subjectCoverage = subjectCovered / Math.max(1, subject.maskArea);
        if (
          subjectCoverage < TEXT_COMPOSITE_CHILD_MIN_SUBJECT_COVERAGE ||
          firstIntersection / Math.max(1, first.maskArea) <
            TEXT_COMPOSITE_CHILD_MIN_CHILD_COVERAGE ||
          secondIntersection / Math.max(1, second.maskArea) <
            TEXT_COMPOSITE_CHILD_MIN_CHILD_COVERAGE ||
          firstIntersection / Math.max(1, subject.maskArea) <
            TEXT_COMPOSITE_CHILD_MIN_CONTRIBUTION ||
          secondIntersection / Math.max(1, subject.maskArea) <
            TEXT_COMPOSITE_CHILD_MIN_CONTRIBUTION
        ) {
          continue;
        }
        const firstIsLow = firstGridBox[axis] < secondGridBox[axis];
        const lowBox = firstIsLow ? firstGridBox : secondGridBox;
        const highBox = firstIsLow ? secondGridBox : firstGridBox;
        const keepFirst = subjectWithFirst;
        const keepLow = keepFirst ? firstIsLow : !firstIsLow;
        const candidate = {
          axis,
          before: lowBox[axis + 2] - 1,
          after: highBox[axis],
          keepLow,
          coverage: subjectCoverage,
        };
        if (!best || candidate.coverage > best.coverage) best = candidate;
      }
    }
    if (!best) return subject;
    const mask = keepMaskAxisSide(
      subject.mask,
      subject.maskWidth,
      subject.maskHeight,
      best.axis,
      best.before,
      best.after,
      best.keepLow,
    );
    const gridBox = findMaskBox(mask, subject.maskWidth, subject.maskHeight);
    if (!gridBox) return subject;
    return {
      ...subject,
      mask,
      maskArea: countMaskPixels(mask),
      maskBox: gridBoxToPageBox(
        gridBox,
        subject.maskWidth,
        subject.maskHeight,
        subject.pageWidth,
        subject.pageHeight,
      ),
      centroid: maskCentroid(
        mask,
        subject.maskWidth,
        subject.maskHeight,
        subject.pageWidth,
        subject.pageHeight,
      ),
    };
  });
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
    const quantileRefined =
      detection.label === "text"
        ? trimTextMaskOutliers(mask, source.width, source.height, rawGridBox)
        : { area, box: rawGridBox, mask };
    const detectorRefined =
      detection.label === "text"
        ? trimDetectorUnsupportedTextMaskTail(
            quantileRefined,
            detection.box,
            source.width,
            source.height,
            result.imageWidth,
            result.imageHeight,
          )
        : quantileRefined;
    const refined =
      detection.label === "text"
        ? trimPageSpanningVerticalTextTail(
            detectorRefined,
            source.width,
            source.height,
            result.imageWidth,
            result.imageHeight,
          )
        : detectorRefined;
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

function trimDetectorUnsupportedTextMaskTail(
  refined: { area: number; box: PixelBox; mask: Uint8Array },
  detectorBox: PixelBox,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number,
): { area: number; box: PixelBox; mask: Uint8Array } {
  let mask = refined.mask;
  let changed = false;
  for (const axis of [0, 1] as const) {
    const candidates = findMaskTailCandidates(
      mask,
      width,
      height,
      axis,
      TEXT_UNSUPPORTED_TAIL_MIN_GAP_RATIO,
      TEXT_UNSUPPORTED_TAIL_MAX_AREA_RATIO,
    );
    for (const candidate of candidates) {
      const bodyMask = keepMaskAxisSide(
        mask,
        width,
        height,
        axis,
        candidate.before,
        candidate.after,
        !candidate.weakLow,
      );
      const bodyBox = findMaskBox(bodyMask, width, height);
      const fullBox = findMaskBox(mask, width, height);
      if (
        !bodyBox ||
        !fullBox ||
        boxArea(fullBox) / Math.max(1, boxArea(bodyBox)) <
          TEXT_UNSUPPORTED_TAIL_MIN_AREA_GAIN
      ) {
        continue;
      }
      let bodyArea = 0;
      let bodyInDetector = 0;
      let tailInDetector = 0;
      for (let index = 0; index < mask.length; index += 1) {
        if (!mask[index]) continue;
        const coordinate =
          axis === 0 ? index % width : Math.floor(index / width);
        const inTail = candidate.weakLow
          ? coordinate <= candidate.before
          : coordinate >= candidate.after;
        const x = ((index % width) + 0.5) * (pageWidth / width);
        const y = (Math.floor(index / width) + 0.5) * (pageHeight / height);
        const inDetector = pointInBox(x, y, detectorBox);
        if (inTail) {
          if (inDetector) tailInDetector += 1;
        } else {
          bodyArea += 1;
          if (inDetector) bodyInDetector += 1;
        }
      }
      if (
        bodyInDetector / Math.max(1, bodyArea) <
          TEXT_UNSUPPORTED_TAIL_MIN_BODY_BOX_SUPPORT ||
        tailInDetector / Math.max(1, candidate.weakArea) >
          TEXT_UNSUPPORTED_TAIL_MAX_TAIL_BOX_SUPPORT
      ) {
        continue;
      }
      mask = bodyMask;
      changed = true;
      break;
    }
  }
  if (!changed) return refined;
  const box = findMaskBox(mask, width, height);
  return box ? { area: countMaskPixels(mask), box, mask } : refined;
}

function trimBorrowedTextMaskTails(text: MaskDetection[]): MaskDetection[] {
  const original = [...text];
  return text.map((item) => {
    if (item.detection.score < TEXT_DETECTOR_OWNED_TAIL_MIN_SUBJECT_SCORE) {
      return item;
    }
    let current = item;
    for (const axis of [0, 1] as const) {
      const split = findBorrowedTextMaskTail(current, original, axis);
      if (!split) continue;
      const mask = keepMaskAxisSide(
        current.mask,
        current.maskWidth,
        current.maskHeight,
        axis,
        split.before,
        split.after,
        !split.weakLow,
      );
      const gridBox = findMaskBox(mask, current.maskWidth, current.maskHeight);
      if (!gridBox) continue;
      current = {
        ...current,
        mask,
        maskArea: countMaskPixels(mask),
        maskBox: gridBoxToPageBox(
          gridBox,
          current.maskWidth,
          current.maskHeight,
          current.pageWidth,
          current.pageHeight,
        ),
        centroid: maskCentroid(
          mask,
          current.maskWidth,
          current.maskHeight,
          current.pageWidth,
          current.pageHeight,
        ),
      };
    }
    return current;
  });
}

function findBorrowedTextMaskTail(
  subject: MaskDetection,
  text: MaskDetection[],
  axis: 0 | 1,
): { before: number; after: number; weakLow: boolean } | null {
  const candidates = findMaskTailCandidates(
    subject.mask,
    subject.maskWidth,
    subject.maskHeight,
    axis,
    TEXT_BORROWED_TAIL_MIN_GAP_RATIO,
    Math.max(
      TEXT_BORROWED_TAIL_MAX_AREA_RATIO,
      TEXT_DETECTOR_OWNED_TAIL_MAX_AREA_RATIO,
    ),
  );
  for (const candidate of candidates) {
    const bodyMask = keepMaskAxisSide(
      subject.mask,
      subject.maskWidth,
      subject.maskHeight,
      axis,
      candidate.before,
      candidate.after,
      !candidate.weakLow,
    );
    const bodyBox = findMaskBox(
      bodyMask,
      subject.maskWidth,
      subject.maskHeight,
    );
    const fullBox = findMaskBox(
      subject.mask,
      subject.maskWidth,
      subject.maskHeight,
    );
    if (
      !bodyBox ||
      !fullBox ||
      boxArea(fullBox) / Math.max(1, boxArea(bodyBox)) <
        TEXT_MASK_OUTLIER_MIN_AREA_GAIN
    ) {
      continue;
    }
    const weakAreaRatio = candidate.weakArea / Math.max(1, subject.maskArea);
    let weakInsideSubjectDetector = 0;
    let bodyInsideSubjectDetector = 0;
    for (let index = 0; index < subject.mask.length; index += 1) {
      if (!subject.mask[index]) continue;
      const coordinate =
        axis === 0
          ? index % subject.maskWidth
          : Math.floor(index / subject.maskWidth);
      const inWeakSide = candidate.weakLow
        ? coordinate <= candidate.before
        : coordinate >= candidate.after;
      const x =
        ((index % subject.maskWidth) + 0.5) *
        (subject.pageWidth / subject.maskWidth);
      const y =
        (Math.floor(index / subject.maskWidth) + 0.5) *
        (subject.pageHeight / subject.maskHeight);
      if (!pointInBox(x, y, subject.detection.box)) continue;
      if (inWeakSide) weakInsideSubjectDetector += 1;
      else bodyInsideSubjectDetector += 1;
    }
    for (const peer of text) {
      if (
        peer === subject ||
        peer.detection.score < TEXT_BORROWED_TAIL_MIN_OWNER_SCORE ||
        isDuplicateText(subject, peer, false)
      ) {
        continue;
      }
      let weakIntersection = 0;
      let bodyIntersection = 0;
      let weakInsidePeerDetector = 0;
      for (let index = 0; index < subject.mask.length; index += 1) {
        if (!subject.mask[index]) continue;
        const coordinate =
          axis === 0
            ? index % subject.maskWidth
            : Math.floor(index / subject.maskWidth);
        const inWeakSide = candidate.weakLow
          ? coordinate <= candidate.before
          : coordinate >= candidate.after;
        if (peer.mask[index]) {
          if (inWeakSide) weakIntersection += 1;
          else bodyIntersection += 1;
        }
        if (inWeakSide) {
          const x =
            ((index % subject.maskWidth) + 0.5) *
            (subject.pageWidth / subject.maskWidth);
          const y =
            (Math.floor(index / subject.maskWidth) + 0.5) *
            (subject.pageHeight / subject.maskHeight);
          if (pointInBox(x, y, peer.detection.box)) {
            weakInsidePeerDetector += 1;
          }
        }
      }
      const weakOwnership = weakIntersection / Math.max(1, candidate.weakArea);
      const bodyOverlap =
        bodyIntersection /
        Math.max(
          1,
          Math.min(subject.maskArea - candidate.weakArea, peer.maskArea),
        );
      const detectorGapGrid =
        axis === 0
          ? axisGap(
              subject.detection.box[0],
              subject.detection.box[2],
              peer.detection.box[0],
              peer.detection.box[2],
            ) *
            (subject.maskWidth / subject.pageWidth)
          : axisGap(
              subject.detection.box[1],
              subject.detection.box[3],
              peer.detection.box[1],
              peer.detection.box[3],
            ) *
            (subject.maskHeight / subject.pageHeight);
      const borrowedTail =
        subject.detection.score >= TEXT_BORROWED_TAIL_MIN_SUBJECT_SCORE &&
        weakAreaRatio <= TEXT_BORROWED_TAIL_MAX_AREA_RATIO &&
        weakOwnership >= TEXT_BORROWED_TAIL_MIN_OWNERSHIP &&
        bodyOverlap <= TEXT_BORROWED_TAIL_MAX_BODY_OVERLAP &&
        peer.maskArea >= candidate.weakArea * 2;
      const detectorOwnedTail =
        subject.detection.score >= TEXT_DETECTOR_OWNED_TAIL_MIN_SUBJECT_SCORE &&
        weakOwnership >= TEXT_BORROWED_TAIL_MIN_OWNERSHIP &&
        weakInsidePeerDetector / Math.max(1, candidate.weakArea) >=
          TEXT_DETECTOR_OWNED_TAIL_MIN_PEER_SUPPORT &&
        weakInsideSubjectDetector / Math.max(1, candidate.weakArea) <=
          TEXT_DETECTOR_OWNED_TAIL_MAX_SUBJECT_SUPPORT &&
        bodyInsideSubjectDetector /
          Math.max(1, subject.maskArea - candidate.weakArea) >=
          TEXT_DETECTOR_OWNED_TAIL_MIN_BODY_SUPPORT &&
        detectorGapGrid >= TEXT_DETECTOR_OWNED_TAIL_MIN_BOX_GAP_GRID &&
        peer.maskArea >= candidate.weakArea * 2;
      if (borrowedTail || detectorOwnedTail) {
        return candidate;
      }
    }
  }
  return null;
}

function findMaskTailCandidates(
  mask: Uint8Array,
  width: number,
  height: number,
  axis: 0 | 1,
  minimumGapRatio: number,
  maximumAreaRatio: number,
): Array<{
  before: number;
  after: number;
  gap: number;
  weakArea: number;
  weakLow: boolean;
}> {
  const areas = maskAxisAreas(mask, width, height, axis);
  const occupied = areas.flatMap((area, coordinate) =>
    area > 0 ? [coordinate] : [],
  );
  const minimumGap = Math.max(
    2,
    Math.ceil((axis === 0 ? width : height) * minimumGapRatio),
  );
  const candidates: Array<{
    before: number;
    after: number;
    gap: number;
    weakArea: number;
    weakLow: boolean;
  }> = [];
  for (let index = 1; index < occupied.length; index += 1) {
    const before = occupied[index - 1] ?? 0;
    const after = occupied[index] ?? before;
    const gap = after - before - 1;
    if (gap < minimumGap) continue;
    const lowArea = areas
      .slice(0, before + 1)
      .reduce((sum, value) => sum + value, 0);
    const highArea = areas.slice(after).reduce((sum, value) => sum + value, 0);
    const weakArea = Math.min(lowArea, highArea);
    if (weakArea / Math.max(1, lowArea + highArea) > maximumAreaRatio) {
      continue;
    }
    candidates.push({
      before,
      after,
      gap,
      weakArea,
      weakLow: lowArea <= highArea,
    });
  }
  return candidates.sort(
    (left, right) => right.gap - left.gap || left.weakArea - right.weakArea,
  );
}

function maskAxisAreas(
  mask: Uint8Array,
  width: number,
  height: number,
  axis: 0 | 1,
): number[] {
  const areas = Array.from({ length: axis === 0 ? width : height }, () => 0);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const coordinate = axis === 0 ? index % width : Math.floor(index / width);
    areas[coordinate] = (areas[coordinate] ?? 0) + 1;
  }
  return areas;
}

function keepMaskAxisSide(
  mask: Uint8Array,
  width: number,
  _height: number,
  axis: 0 | 1,
  before: number,
  after: number,
  keepLow: boolean,
): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const coordinate = axis === 0 ? index % width : Math.floor(index / width);
    if (keepLow ? coordinate <= before : coordinate >= after) {
      output[index] = 1;
    }
  }
  return output;
}

function trimPageSpanningVerticalTextTail(
  refined: { area: number; box: PixelBox; mask: Uint8Array },
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number,
): { area: number; box: PixelBox; mask: Uint8Array } {
  const pageBox = gridBoxToPageBox(
    refined.box,
    width,
    height,
    pageWidth,
    pageHeight,
  );
  if (!isPageSpanningVerticalStrip(pageBox, pageHeight)) return refined;
  const mask = new Uint8Array(refined.mask);
  const minimumGap = Math.max(
    2,
    Math.ceil(height * TEXT_VERTICAL_STRIP_TAIL_MIN_GAP_RATIO),
  );
  let changed = false;
  while (true) {
    const rowAreas = Array.from({ length: height }, (_, y) => {
      let area = 0;
      for (let x = 0; x < width; x += 1) area += mask[y * width + x] ?? 0;
      return area;
    });
    const occupiedRows = rowAreas.flatMap((rowArea, y) =>
      rowArea > 0 ? [y] : [],
    );
    let split: { after: number; before: number; gap: number } | null = null;
    for (let index = 1; index < occupiedRows.length; index += 1) {
      const previous = occupiedRows[index - 1] ?? 0;
      const next = occupiedRows[index] ?? previous;
      const gap = next - previous - 1;
      if (!split || gap > split.gap) {
        split = { after: next, before: previous, gap };
      }
    }
    if (!split || split.gap < minimumGap) break;
    const beforeArea = rowAreas
      .slice(0, split.before + 1)
      .reduce((sum, value) => sum + value, 0);
    const afterArea = rowAreas
      .slice(split.after)
      .reduce((sum, value) => sum + value, 0);
    const totalArea = beforeArea + afterArea;
    const weakArea = Math.min(beforeArea, afterArea);
    const weakLimit = Math.max(
      1,
      Math.floor(totalArea * TEXT_VERTICAL_STRIP_TAIL_MAX_AREA_RATIO),
    );
    if (
      weakArea > weakLimit ||
      weakArea / Math.max(1, totalArea) >
        TEXT_VERTICAL_STRIP_TAIL_MAX_AREA_RATIO
    ) {
      break;
    }
    const removeBefore = beforeArea <= afterArea;
    const from = removeBefore ? 0 : split.after;
    const to = removeBefore ? split.before + 1 : height;
    for (let y = from; y < to; y += 1) {
      mask.fill(0, y * width, (y + 1) * width);
    }
    changed = true;
  }
  if (!changed) return refined;
  const box = findMaskBox(mask, width, height);
  return box ? { area: countMaskPixels(mask), box, mask } : refined;
}

function isPageSpanningVerticalStrip(
  box: PixelBox,
  pageHeight: number,
): boolean {
  const width = Math.max(1, box[2] - box[0]);
  const height = Math.max(1, box[3] - box[1]);
  return (
    height / Math.max(1, pageHeight) >= TEXT_VERTICAL_STRIP_MIN_PAGE_HEIGHT &&
    height / width >= TEXT_VERTICAL_STRIP_MIN_ASPECT_RATIO
  );
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
    const broadSparseProposal =
      areaFraction >= TEXT_BROAD_SPARSE_MIN_PAGE_AREA &&
      density <= TEXT_BROAD_SPARSE_MAX_DENSITY &&
      containerSupport < TEXT_BROAD_SPARSE_MAX_CONTAINER_MASK_SUPPORT;
    // Koharu can occasionally bind unrelated glyphs from several stacked
    // panels (or a publisher's full-height recommendation rail) into one
    // very narrow text mask. Mask support is not a safe exception here: one
    // dense fragment may sit inside a valid bubble while a few distant glyphs
    // stretch the proposal across half the page. Normal vertical dialogue,
    // including narrow tall balloons, stays well below this joint span/aspect
    // boundary in the sealed manga audit set.
    const pageSpanningVerticalStrip = isPageSpanningVerticalStrip(
      item.maskBox,
      item.pageHeight,
    );
    if (broadSparseProposal || pageSpanningVerticalStrip) {
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
): { regions: MutableRegion[]; fragmentPairs: TextFragmentPair[] } {
  const ownershipByText = new Map(
    text.map((item) => [
      item,
      assignments.get(item)?.detectionId ?? `free:${item.detectionId}`,
    ]),
  );
  const groups = new DisjointSet(text.length);
  const fragmentPairs: TextFragmentPair[] = [];
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
      } else if (
        sameBubble &&
        isSameBubbleTextFragment(text[left], text[right])
      ) {
        fragmentPairs.push([text[left].detectionId, text[right].detectionId]);
      }
    }
  }
  const membersByRoot = new Map<number, MaskDetection[]>();
  text.forEach((item, index) => {
    const root = groups.find(index);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), item]);
  });
  return {
    regions: [...membersByRoot.values()].map((members) =>
      createRegion(
        members,
        "dialogue",
        width,
        height,
        5,
        members.map(
          (member) =>
            ownershipByText.get(member) ?? `free:${member.detectionId}`,
        ),
      ),
    ),
    fragmentPairs,
  };
}

function isSameBubbleTextFragment(
  first: MaskDetection,
  second: MaskDetection,
): boolean {
  if (
    Math.min(first.detection.score, second.detection.score) <
    TEXT_FRAGMENT_MIN_SCORE
  ) {
    return false;
  }
  const smallerMask = Math.max(1, Math.min(first.maskArea, second.maskArea));
  const largerMask = Math.max(1, Math.max(first.maskArea, second.maskArea));
  const maskAreaRatio = smallerMask / largerMask;
  const maskOverlap = maskIntersection(first, second) / smallerMask;
  if (
    maskAreaRatio < TEXT_FRAGMENT_MIN_MASK_AREA_RATIO ||
    maskOverlap > TEXT_FRAGMENT_MAX_MASK_OVERLAP ||
    boxIntersection(first.maskBox, second.maskBox) <= 0
  ) {
    return false;
  }
  const firstWidth = Math.max(1, first.maskBox[2] - first.maskBox[0]);
  const firstHeight = Math.max(1, first.maskBox[3] - first.maskBox[1]);
  const secondWidth = Math.max(1, second.maskBox[2] - second.maskBox[0]);
  const secondHeight = Math.max(1, second.maskBox[3] - second.maskBox[1]);
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
  const horizontalSeparation =
    Math.abs(
      (first.maskBox[0] + first.maskBox[2]) / 2 -
        (second.maskBox[0] + second.maskBox[2]) / 2,
    ) / Math.min(firstWidth, secondWidth);
  const verticalSeparation =
    Math.abs(
      (first.maskBox[1] + first.maskBox[3]) / 2 -
        (second.maskBox[1] + second.maskBox[3]) / 2,
    ) / Math.min(firstHeight, secondHeight);
  return (
    (horizontalOverlap >= TEXT_FRAGMENT_MIN_CROSS_AXIS_OVERLAP &&
      verticalSeparation >= TEXT_FRAGMENT_MIN_PRIMARY_AXIS_SEPARATION) ||
    (verticalOverlap >= TEXT_FRAGMENT_MIN_CROSS_AXIS_OVERLAP &&
      horizontalSeparation >= TEXT_FRAGMENT_MIN_PRIMARY_AXIS_SEPARATION)
  );
}

function mergeDialogueFragments(
  regions: MutableRegion[],
  fragmentPairs: readonly TextFragmentPair[],
): number {
  let merges = 0;
  for (const [firstId, secondId] of fragmentPairs) {
    const firstIndex = regions.findIndex((region) =>
      region.sourceDetectionIds.includes(firstId),
    );
    const secondIndex = regions.findIndex((region) =>
      region.sourceDetectionIds.includes(secondId),
    );
    if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) {
      continue;
    }
    const first = regions[firstIndex];
    const second = regions[secondIndex];
    const verticalStack =
      axisOverlap(
        first.bbox[0],
        first.bbox[2],
        second.bbox[0],
        second.bbox[2],
      ) >=
      axisOverlap(first.bbox[1], first.bbox[3], second.bbox[1], second.bbox[3]);
    const recognitionBboxes = [
      ...(first.recognitionBboxes.length
        ? first.recognitionBboxes
        : [first.bbox]),
      ...(second.recognitionBboxes.length
        ? second.recognitionBboxes
        : [second.bbox]),
    ].sort((left, right) =>
      verticalStack
        ? left[1] - right[1] || right[0] - left[0]
        : right[0] - left[0] || left[1] - right[1],
    );
    const merged = mergeRegions(first, second);
    merged.recognitionBboxes = recognitionBboxes;
    const keepIndex = Math.min(firstIndex, secondIndex);
    const removeIndex = Math.max(firstIndex, secondIndex);
    regions[keepIndex] = merged;
    regions.splice(removeIndex, 1);
    merges += 1;
  }
  return merges;
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
  if (
    boxContainment >= 0.8 &&
    maskOverlap >= PROTRUDING_CHILD_MIN_MASK_OVERLAP
  ) {
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
    recognitionBboxes: [],
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
          shouldPreserveDistinctDialogueRegions(regions[left], regions[right])
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

function shouldPreserveDistinctDialogueRegions(
  first: MutableRegion,
  second: MutableRegion,
): boolean {
  // Overlap and shared bubble ownership are not evidence that two utterances
  // are one block. If a lossless boundary is unavailable, retain both
  // dialogue regions for a later local boundary repair instead of unioning
  // them. Effect regions keep their historical grouping behavior.
  return first.kind === "dialogue" && second.kind === "dialogue";
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
    recognitionBboxes: [
      ...first.recognitionBboxes,
      ...second.recognitionBboxes,
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
      ...(region.recognitionBboxes.length > 1
        ? {
            recognitionBboxes: region.recognitionBboxes.map(
              (box) =>
                box.map((value) => Math.round(value * 1000) / 1000) as PixelBox,
            ),
          }
        : {}),
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
