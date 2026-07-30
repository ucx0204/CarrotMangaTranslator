import type { BBox } from "../../shared/textTypes";

export type PartitionAxis = "x" | "y";

export function choosePartitionAxis(
  boxes: BBox[],
  bubbleBox: BBox,
): PartitionAxis {
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

export function buildPartitionCuts(
  boxes: BBox[],
  axis: PartitionAxis,
): number[] {
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

export function constrainPartitionCuts(
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

export function buildPartitionBox(
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

export function otherAxis(axis: PartitionAxis): PartitionAxis {
  return axis === "x" ? "y" : "x";
}

export function axisCenter(box: BBox, axis: PartitionAxis): number {
  return axisStart(box, axis) + axisLength(box, axis) / 2;
}

export function resolvePartitionGapPx(requestedGapPx: number): number {
  if (!Number.isFinite(requestedGapPx)) return 3;
  if (requestedGapPx <= 0) return 0;
  return clamp(requestedGapPx, 3, 6);
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

function axisStart(box: BBox, axis: PartitionAxis): number {
  return axis === "x" ? box.x : box.y;
}

function axisLength(box: BBox, axis: PartitionAxis): number {
  return axis === "x" ? box.w : box.h;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
