import type { BBox } from "../../shared/textTypes";
import type {
  BlockBubbleCandidate,
  BlockBubbleCandidateOwnership,
  BubbleOwnershipPartition,
} from "./bubbleBlockAssociation";

/**
 * Bubbles claimed by different OCR blocks can overlap even when the detector
 * returned separate bubble objects for connected lobes. Build conflict
 * components from candidate boxes that overlap or sit closer than the gutter.
 * All claims of an owner in a conflict stay in one component so their final
 * union bounds cannot bridge across another owner's cell.
 */
export function partitionSharedBubbleOwnership<Owner>(
  ownerships: readonly BlockBubbleCandidateOwnership<Owner>[],
  ownerBox: (owner: Owner) => BBox,
  requestedGapPx: number,
): BlockBubbleCandidateOwnership<Owner>[] {
  const claims = collectCandidateClaims(ownerships);
  const gapPx = resolvePartitionGapPx(requestedGapPx);
  const partitionsByCandidate = new Map<
    BlockBubbleCandidate,
    BubbleOwnershipPartition
  >();
  for (const conflict of findOwnershipConflicts(claims, gapPx)) {
    for (const result of buildConflictPartitions(conflict, ownerBox, gapPx)) {
      partitionsByCandidate.set(result.candidate, result.partition);
    }
  }
  return ownerships.map((ownership) => ({
    owner: ownership.owner,
    candidates: ownership.candidates.map((candidate) => {
      const partition = partitionsByCandidate.get(candidate);
      return partition
        ? { ...candidate, ownershipPartition: partition }
        : candidate;
    }),
  }));
}

type BubbleClaim<Owner> = {
  owner: Owner;
  candidate: BlockBubbleCandidate;
};

function collectCandidateClaims<Owner>(
  ownerships: readonly BlockBubbleCandidateOwnership<Owner>[],
): BubbleClaim<Owner>[] {
  return ownerships.flatMap((ownership) =>
    ownership.candidates.map((candidate) => ({
      owner: ownership.owner,
      candidate,
    })),
  );
}

function findOwnershipConflicts<Owner>(
  claims: BubbleClaim<Owner>[],
  requestedGapPx: number,
): BubbleClaim<Owner>[][] {
  const parents = claims.map((_, index) => index);
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const sameOwner = claims[left].owner === claims[right].owner;
      const competingBoxesAreTooClose =
        !sameOwner &&
        boxesAreCloserThanGap(
          claims[left].candidate.bubbleBox,
          claims[right].candidate.bubbleBox,
          requestedGapPx,
        );
      if (sameOwner || competingBoxesAreTooClose) {
        joinConflict(parents, left, right);
      }
    }
  }
  const components = new Map<number, BubbleClaim<Owner>[]>();
  for (const [index, claim] of claims.entries()) {
    const root = findConflictRoot(parents, index);
    const component = components.get(root) ?? [];
    component.push(claim);
    components.set(root, component);
  }
  return [...components.values()].filter(
    (component) => new Set(component.map((claim) => claim.owner)).size > 1,
  );
}

function findConflictRoot(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root];
  let cursor = index;
  while (parents[cursor] !== cursor) {
    const parent = parents[cursor];
    parents[cursor] = root;
    cursor = parent;
  }
  return root;
}

function joinConflict(parents: number[], left: number, right: number): void {
  const leftRoot = findConflictRoot(parents, left);
  const rightRoot = findConflictRoot(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function buildConflictPartitions<Owner>(
  claims: BubbleClaim<Owner>[],
  ownerBox: (owner: Owner) => BBox,
  requestedGapPx: number,
): {
  candidate: BlockBubbleCandidate;
  partition: BubbleOwnershipPartition;
}[] {
  const bubbleBox = unionBounds(
    claims.map((claim) => claim.candidate.bubbleBox),
  );
  const owners = uniqueOwners(claims).map((owner) => ({
    owner,
    box: ownerBox(owner),
  }));
  const axis = choosePartitionAxis(
    owners.map((owner) => owner.box),
    bubbleBox,
  );
  const ordered = orderOwners(owners, axis);
  const gapPx = resolvePartitionGapPx(requestedGapPx);
  const cuts = constrainPartitionCuts(
    buildPartitionCuts(
      ordered.map((claim) => claim.box),
      axis,
    ),
    bubbleBox,
    axis,
    gapPx,
  );
  const partitionsByOwner = new Map(
    ordered.map((owner, index) => [
      owner.owner,
      {
        clipBox: buildPartitionBox(bubbleBox, axis, cuts, index, gapPx),
        gapPx,
        ownerCount: ordered.length,
      },
    ]),
  );
  return claims.map((claim) => ({
    candidate: claim.candidate,
    partition: requirePartition(partitionsByOwner.get(claim.owner)),
  }));
}

function uniqueOwners<Owner>(claims: BubbleClaim<Owner>[]): Owner[] {
  return [...new Set(claims.map((claim) => claim.owner))];
}

function orderOwners<Owner>(
  owners: { owner: Owner; box: BBox }[],
  axis: PartitionAxis,
): { owner: Owner; box: BBox }[] {
  return [...owners].sort(
    (left, right) =>
      axisCenter(left.box, axis) - axisCenter(right.box, axis) ||
      axisCenter(left.box, otherAxis(axis)) -
        axisCenter(right.box, otherAxis(axis)),
  );
}

function requirePartition(
  partition: BubbleOwnershipPartition | undefined,
): BubbleOwnershipPartition {
  if (!partition) {
    throw new Error("공유 말풍선 소유권 분할 결과가 누락되었습니다.");
  }
  return partition;
}

function unionBounds(boxes: BBox[]): BBox {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x, y, w: right - x, h: bottom - y };
}

type PartitionAxis = "x" | "y";

function choosePartitionAxis(boxes: BBox[], bubbleBox: BBox): PartitionAxis {
  const score = (axis: PartitionAxis) => {
    const centers = boxes.map((box) => axisCenter(box, axis));
    const spread = Math.max(...centers) - Math.min(...centers);
    const meanExtent =
      boxes.reduce((total, box) => total + axisLength(box, axis), 0) /
      Math.max(1, boxes.length);
    return (
      spread / Math.max(1, meanExtent) +
      (spread / Math.max(1, axisLength(bubbleBox, axis))) * 0.35
    );
  };
  return score("x") >= score("y") ? "x" : "y";
}

function buildPartitionCuts(boxes: BBox[], axis: PartitionAxis): number[] {
  const cuts: number[] = [];
  for (let index = 0; index < boxes.length - 1; index += 1) {
    const current = boxes[index];
    const next = boxes[index + 1];
    const currentEnd = axisStart(current, axis) + axisLength(current, axis);
    const nextStart = axisStart(next, axis);
    cuts.push(
      currentEnd <= nextStart
        ? (currentEnd + nextStart) / 2
        : (axisCenter(current, axis) + axisCenter(next, axis)) / 2,
    );
  }
  return cuts;
}

function constrainPartitionCuts(
  idealCuts: number[],
  bubbleBox: BBox,
  axis: PartitionAxis,
  gapPx: number,
): number[] {
  if (idealCuts.length === 0) return [];
  const start = axisStart(bubbleBox, axis);
  const end = start + axisLength(bubbleBox, axis);
  const minimumCellSize = 2;
  const requiredLength =
    minimumCellSize * (idealCuts.length + 1) + gapPx * idealCuts.length;
  if (end - start < requiredLength) {
    return evenlySpacedCuts(start, end, idealCuts.length);
  }
  const cuts = [...idealCuts];
  for (let index = 0; index < cuts.length; index += 1) {
    cuts[index] = Math.max(
      cuts[index],
      start + minimumCellSize * (index + 1) + gapPx * index + gapPx / 2,
    );
  }
  for (let index = cuts.length - 1; index >= 0; index -= 1) {
    const remainingCells = cuts.length - index;
    cuts[index] = Math.min(
      cuts[index],
      end -
        minimumCellSize * remainingCells -
        gapPx * (remainingCells - 1) -
        gapPx / 2,
    );
  }
  return cuts;
}

function evenlySpacedCuts(
  start: number,
  end: number,
  cutCount: number,
): number[] {
  return Array.from(
    { length: cutCount },
    (_, index) => start + ((end - start) * (index + 1)) / (cutCount + 1),
  );
}

function buildPartitionBox(
  bubbleBox: BBox,
  axis: PartitionAxis,
  cuts: number[],
  index: number,
  gapPx: number,
): BBox {
  const bubbleStart = axisStart(bubbleBox, axis);
  const bubbleEnd = bubbleStart + axisLength(bubbleBox, axis);
  const start =
    index === 0
      ? bubbleStart
      : Math.min(bubbleEnd, cuts[index - 1] + gapPx / 2);
  const end =
    index === cuts.length
      ? bubbleEnd
      : Math.max(bubbleStart, cuts[index] - gapPx / 2);
  return axis === "x"
    ? {
        x: start,
        y: bubbleBox.y,
        w: Math.max(0, end - start),
        h: bubbleBox.h,
      }
    : {
        x: bubbleBox.x,
        y: start,
        w: bubbleBox.w,
        h: Math.max(0, end - start),
      };
}

function otherAxis(axis: PartitionAxis): PartitionAxis {
  return axis === "x" ? "y" : "x";
}

function axisStart(box: BBox, axis: PartitionAxis): number {
  return axis === "x" ? box.x : box.y;
}

function axisLength(box: BBox, axis: PartitionAxis): number {
  return axis === "x" ? box.w : box.h;
}

function axisCenter(box: BBox, axis: PartitionAxis): number {
  return axisStart(box, axis) + axisLength(box, axis) / 2;
}

function boxesAreCloserThanGap(
  left: BBox,
  right: BBox,
  requestedGapPx: number,
): boolean {
  const gapPx = Math.max(0, requestedGapPx);
  return (
    axisSeparation(left.x, left.w, right.x, right.w) < gapPx &&
    axisSeparation(left.y, left.h, right.y, right.h) < gapPx
  );
}

function axisSeparation(
  leftStart: number,
  leftLength: number,
  rightStart: number,
  rightLength: number,
): number {
  return Math.max(
    0,
    Math.max(leftStart, rightStart) -
      Math.min(leftStart + leftLength, rightStart + rightLength),
  );
}

function resolvePartitionGapPx(requestedGapPx: number): number {
  return Number.isFinite(requestedGapPx) ? clamp(requestedGapPx, 3, 6) : 3;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
