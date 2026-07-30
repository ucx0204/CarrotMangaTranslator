import type { BBox } from "../../shared/textTypes";
import type {
  BlockBubbleCandidate,
  BlockBubbleCandidateOwnership,
  BubbleOwnershipPartition,
} from "./bubbleBlockAssociation";
import {
  axisCenter,
  buildPartitionBox,
  buildPartitionCuts,
  choosePartitionAxis,
  constrainPartitionCuts,
  otherAxis,
  resolvePartitionGapPx,
  type PartitionAxis,
} from "./bubbleOwnershipGeometry";

/**
 * A detector bubble claimed by multiple OCR blocks needs a shared ownership
 * cell. Separately detected connected lobes retain their own refined contours
 * outside the actual bubble overlap; only their overlapping lens is assigned.
 * This avoids the long artificial seam produced by globally cutting boxes.
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
  for (const [conflictIndex, conflict] of findOwnershipConflicts(
    claims,
  ).entries()) {
    for (const result of buildConflictPartitions(
      conflict,
      ownerBox,
      gapPx,
      `shared-${conflictIndex + 1}`,
    )) {
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
): BubbleClaim<Owner>[][] {
  const parents = claims.map((_, index) => index);
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const sameOwner = claims[left].owner === claims[right].owner;
      const competingOwnersShareDetection =
        !sameOwner &&
        claims[left].candidate.bubbleDetection ===
          claims[right].candidate.bubbleDetection;
      const competingBubbleBoxesOverlap =
        !sameOwner &&
        boxesOverlap(
          claims[left].candidate.bubbleBox,
          claims[right].candidate.bubbleBox,
        );
      if (
        sameOwner ||
        competingOwnersShareDetection ||
        competingBubbleBoxesOverlap
      ) {
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
  sharedGroupId: string,
): {
  candidate: BlockBubbleCandidate;
  partition: BubbleOwnershipPartition;
}[] {
  const bubbleBox = unionBounds(
    claims.map((claim) => claim.candidate.bubbleBox),
  );
  return buildDisjointConflictPartitions(
    claims,
    ownerBox,
    requestedGapPx,
    bubbleBox,
    sharedGroupId,
  );
}

function buildDisjointConflictPartitions<Owner>(
  claims: BubbleClaim<Owner>[],
  ownerBox: (owner: Owner) => BBox,
  requestedGapPx: number,
  bubbleBox: BBox,
  sharedGroupId: string,
): Array<{
  candidate: BlockBubbleCandidate;
  partition: BubbleOwnershipPartition;
}> {
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
        ownerBox: owner.box,
        competingOwnerBoxes: ordered
          .filter((_, competingIndex) => competingIndex !== index)
          .map((competingOwner) => competingOwner.box),
      },
    ]),
  );
  return claims.map((claim) => {
    const base = requirePartition(partitionsByOwner.get(claim.owner));
    const competingClaims = claims.filter(
      (competingClaim) => competingClaim.owner !== claim.owner,
    );
    const sharesDetection = competingClaims.some(
      (competingClaim) =>
        competingClaim.candidate.bubbleDetection ===
        claim.candidate.bubbleDetection,
    );
    const competingBubbleBoxes = deduplicateBoxes(
      competingClaims
        .filter(
          (competingClaim) =>
            sharesDetection ||
            boxesOverlap(
              claim.candidate.bubbleBox,
              competingClaim.candidate.bubbleBox,
            ),
        )
        .map((competingClaim) => competingClaim.candidate.bubbleBox),
    );
    return {
      candidate: claim.candidate,
      partition: {
        ...base,
        sharedGroupId,
        competingBubbleBoxes,
        scope: sharesDetection ? "full" : "bubble-overlap",
        gapPx,
        ownerCount: ordered.length,
      },
    };
  });
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
  partition:
    | Pick<
        BubbleOwnershipPartition,
        "clipBox" | "ownerBox" | "competingOwnerBoxes"
      >
    | undefined,
): Pick<
  BubbleOwnershipPartition,
  "clipBox" | "ownerBox" | "competingOwnerBoxes"
> {
  if (!partition) {
    throw new Error("공유 말풍선 소유권 분할 결과가 누락되었습니다.");
  }
  return partition;
}

function boxesOverlap(left: BBox, right: BBox): boolean {
  return (
    Math.min(left.x + left.w, right.x + right.w) > Math.max(left.x, right.x) &&
    Math.min(left.y + left.h, right.y + right.h) > Math.max(left.y, right.y)
  );
}

function deduplicateBoxes(boxes: readonly BBox[]): BBox[] {
  const seen = new Set<string>();
  return boxes.filter((box) => {
    const key = [box.x, box.y, box.w, box.h].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unionBounds(boxes: BBox[]): BBox {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x, y, w: right - x, h: bottom - y };
}
