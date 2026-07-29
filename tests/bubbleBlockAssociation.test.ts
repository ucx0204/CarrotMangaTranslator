import { describe, expect, it } from "vitest";
import {
  gateExclusiveBubbleOwnership,
  selectBlockBubbleCandidates,
} from "../src/main/bubbleLayout/bubbleBlockAssociation";
import { partitionSharedBubbleOwnership } from "../src/main/bubbleLayout/bubbleOwnershipPartition";
import { associateComicDetections } from "../src/main/bubbleLayout/association";
import type {
  ComicDetectionLabelId,
  ComicPageDetection,
} from "../src/main/bubbleLayout/contracts";

describe("block-to-bubble association", () => {
  it("keeps two connected speech balloons for one merged OCR block", () => {
    const detections = [
      detection(0, [10, 10, 55, 60], 0.95),
      detection(0, [60, 12, 110, 62], 0.94),
      detection(1, [20, 20, 45, 48], 0.96),
      detection(1, [72, 22, 98, 50], 0.93),
    ];
    const associations = associateComicDetections(detections);
    const candidates = selectBlockBubbleCandidates(
      { x: 18, y: 18, w: 82, h: 35 },
      associations,
    );
    const gated = gateExclusiveBubbleOwnership([
      { owner: { id: "merged" }, candidates },
    ]);
    expect(gated[0].candidates).toHaveLength(2);
    expect(
      gated[0].candidates.map((candidate) => candidate.promptBoxes.length),
    ).toEqual([1, 1]);
  });

  it("withholds one detector balloon claimed by two OCR blocks", () => {
    const associations = associateComicDetections([
      detection(0, [10, 10, 110, 70], 0.96),
      detection(1, [20, 20, 100, 60], 0.97),
    ]);
    const left = { id: "left" };
    const right = { id: "right" };
    const gated = gateExclusiveBubbleOwnership([
      {
        owner: left,
        candidates: selectBlockBubbleCandidates(
          { x: 15, y: 18, w: 40, h: 40 },
          associations,
        ),
      },
      {
        owner: right,
        candidates: selectBlockBubbleCandidates(
          { x: 60, y: 18, w: 40, h: 40 },
          associations,
        ),
      },
    ]);

    expect(gated.map((ownership) => ownership.candidates)).toEqual([[], []]);
  });

  it("partitions a shared detector balloon with a fixed gutter", () => {
    const associations = associateComicDetections([
      detection(0, [10, 10, 110, 70], 0.96),
      detection(1, [20, 20, 100, 60], 0.97),
    ]);
    const left = { id: "left", bbox: { x: 15, y: 18, w: 40, h: 40 } };
    const right = { id: "right", bbox: { x: 60, y: 18, w: 40, h: 40 } };
    const partitioned = partitionSharedBubbleOwnership(
      [left, right].map((owner) => ({
        owner,
        candidates: selectBlockBubbleCandidates(owner.bbox, associations),
      })),
      (owner) => owner.bbox,
      4,
    );

    const leftBox = partitioned[0].candidates[0].ownershipPartition?.clipBox;
    const rightBox = partitioned[1].candidates[0].ownershipPartition?.clipBox;
    expect(leftBox).toBeDefined();
    expect(rightBox).toBeDefined();
    expect((rightBox?.x ?? 0) - ((leftBox?.x ?? 0) + (leftBox?.w ?? 0))).toBe(
      4,
    );
    expect(leftBox?.y).toBe(10);
    expect(rightBox?.h).toBe(60);
  });

  it("uses a horizontal gutter when OCR blocks are stacked", () => {
    const associations = associateComicDetections([
      detection(0, [10, 10, 90, 130], 0.96),
      detection(1, [20, 20, 80, 120], 0.97),
    ]);
    const top = { id: "top", bbox: { x: 25, y: 15, w: 50, h: 48 } };
    const bottom = { id: "bottom", bbox: { x: 25, y: 72, w: 50, h: 48 } };
    const partitioned = partitionSharedBubbleOwnership(
      [top, bottom].map((owner) => ({
        owner,
        candidates: selectBlockBubbleCandidates(owner.bbox, associations),
      })),
      (owner) => owner.bbox,
      5,
    );

    const topBox = partitioned[0].candidates[0].ownershipPartition?.clipBox;
    const bottomBox = partitioned[1].candidates[0].ownershipPartition?.clipBox;
    expect((bottomBox?.y ?? 0) - ((topBox?.y ?? 0) + (topBox?.h ?? 0))).toBe(5);
    expect(topBox?.x).toBe(10);
    expect(bottomBox?.w).toBe(80);
  });

  it("keeps separately detected neighboring balloons on their own contours", () => {
    const associations = associateComicDetections([
      detection(0, [10, 10, 50, 60], 0.96),
      detection(0, [52, 10, 92, 60], 0.95),
      detection(1, [18, 20, 42, 50], 0.97),
      detection(1, [60, 20, 84, 50], 0.96),
    ]);
    const left = { id: "left", bbox: { x: 16, y: 18, w: 28, h: 35 } };
    const right = { id: "right", bbox: { x: 58, y: 18, w: 28, h: 35 } };
    const partitioned = partitionSharedBubbleOwnership(
      [left, right].map((owner) => ({
        owner,
        candidates: selectBlockBubbleCandidates(owner.bbox, associations),
      })),
      (owner) => owner.bbox,
      4,
    );

    expect(partitioned[0].candidates[0].ownershipPartition).toBeUndefined();
    expect(partitioned[1].candidates[0].ownershipPartition).toBeUndefined();
  });

  it("limits distinct connected-balloon ownership to their overlapping lens", () => {
    const associations = associateComicDetections([
      detection(0, [10, 10, 72, 90], 0.96),
      detection(0, [58, 10, 120, 90], 0.95),
      detection(1, [20, 25, 48, 75], 0.97),
      detection(1, [82, 25, 110, 75], 0.96),
    ]);
    const left = { id: "left", bbox: { x: 18, y: 22, w: 34, h: 56 } };
    const right = { id: "right", bbox: { x: 78, y: 22, w: 34, h: 56 } };
    const partitioned = partitionSharedBubbleOwnership(
      [left, right].map((owner) => ({
        owner,
        candidates: selectBlockBubbleCandidates(owner.bbox, associations),
      })),
      (owner) => owner.bbox,
      4,
    );

    const leftPartition = partitioned[0].candidates[0].ownershipPartition;
    const rightPartition = partitioned[1].candidates[0].ownershipPartition;
    expect(leftPartition?.scope).toBe("bubble-overlap");
    expect(rightPartition?.scope).toBe("bubble-overlap");
    expect(leftPartition?.competingBubbleBoxes).toEqual([
      { x: 58, y: 10, w: 62, h: 80 },
    ]);
    expect(rightPartition?.competingBubbleBoxes).toEqual([
      { x: 10, y: 10, w: 62, h: 80 },
    ]);
  });

  it("keeps three diagonally ordered owners pairwise disjoint", () => {
    const associations = associateComicDetections([
      detection(0, [5, 5, 115, 115], 0.98),
      detection(1, [15, 15, 105, 105], 0.98),
    ]);
    const owners = [
      { id: "top-left", bbox: { x: 12, y: 12, w: 24, h: 24 } },
      { id: "center", bbox: { x: 48, y: 48, w: 24, h: 24 } },
      { id: "bottom-right", bbox: { x: 84, y: 84, w: 24, h: 24 } },
    ];
    const partitioned = partitionSharedBubbleOwnership(
      owners.map((owner) => ({
        owner,
        candidates: selectBlockBubbleCandidates(owner.bbox, associations),
      })),
      (owner) => owner.bbox,
      5,
    );
    const boxes = partitioned.map(
      (ownership) => ownership.candidates[0].ownershipPartition?.clipBox,
    );

    expect(boxes.every(Boolean)).toBe(true);
    for (let index = 1; index < boxes.length; index += 1) {
      const previous = boxes[index - 1];
      const current = boxes[index];
      expect(
        (current?.x ?? 0) - ((previous?.x ?? 0) + (previous?.w ?? 0)),
      ).toBe(5);
    }
  });

  it("does not absorb an adjacent balloon with unrelated text", () => {
    const detections = [
      detection(0, [10, 10, 50, 60], 0.95),
      detection(0, [80, 10, 120, 60], 0.95),
      detection(1, [20, 20, 40, 45], 0.95),
      detection(1, [90, 20, 110, 45], 0.95),
    ];
    const candidates = selectBlockBubbleCandidates(
      { x: 18, y: 18, w: 24, h: 30 },
      associateComicDetections(detections),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].bubbleBox.x).toBe(10);
  });

  it("selects one dominant containing balloon instead of an adjacent shard", () => {
    const detections = [
      detection(0, [10, 10, 70, 90], 0.94),
      detection(0, [62, 10, 120, 90], 0.96),
      detection(1, [72, 25, 108, 75], 0.97),
    ];
    const candidates = selectBlockBubbleCandidates(
      { x: 70, y: 22, w: 40, h: 56 },
      associateComicDetections(detections),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].bubbleBox.x).toBe(62);
  });

  it("retains both balloons when a merged OCR block genuinely spans them", () => {
    const detections = [
      detection(0, [10, 10, 65, 90], 0.95),
      detection(0, [60, 10, 120, 90], 0.94),
      detection(1, [20, 25, 52, 75], 0.96),
      detection(1, [72, 25, 108, 75], 0.95),
    ];
    const candidates = selectBlockBubbleCandidates(
      { x: 20, y: 22, w: 88, h: 56 },
      associateComicDetections(detections),
    );

    expect(candidates).toHaveLength(2);
  });
});

function detection(
  labelId: ComicDetectionLabelId,
  box: [number, number, number, number],
  score: number,
): ComicPageDetection {
  const labels = ["bubble", "text_bubble", "text_free"] as const;
  return { labelId, label: labels[labelId], box, score };
}
