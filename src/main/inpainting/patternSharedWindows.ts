import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";

type SharedConstrainedWindowContext = {
  inpaintWindows: PixelRect[];
  inpaintWindowMasks: InpaintingWindowMask[];
  inpaintCompositeMasks: InpaintingWindowMask[];
  inpaintCompositeFeatherPx: number[];
  inpaintWindowConstraints: Array<InpaintingWindowMask | null>;
  inpaintWindowGroupIds: string[][];
};

type SharedWindowEntry = {
  compositeMask: InpaintingWindowMask;
  constraint: InpaintingWindowMask | null;
  featherPx: number;
  groupIds: string[];
  mask: InpaintingWindowMask;
  window: PixelRect;
};

export function coalesceSharedConstrainedWindows(
  context: SharedConstrainedWindowContext,
): void {
  const roots = resolveSharedWindowRoots(context.inpaintWindowGroupIds);
  const windows: PixelRect[] = [];
  const masks: InpaintingWindowMask[] = [];
  const compositeMasks: InpaintingWindowMask[] = [];
  const compositeFeatherPx: number[] = [];
  const constraints: Array<InpaintingWindowMask | null> = [];
  const groupIds: string[][] = [];
  const outputIndexByRoot = new Map<number, number>();
  for (let index = 0; index < context.inpaintWindows.length; index += 1) {
    const entry = readSharedWindowEntry(context, index);
    const root = roots[index] ?? index;
    const outputIndex = outputIndexByRoot.get(root);
    if (outputIndex === undefined) {
      outputIndexByRoot.set(root, windows.length);
      windows.push(entry.window);
      masks.push(entry.mask);
      compositeMasks.push(entry.compositeMask);
      compositeFeatherPx.push(entry.featherPx);
      constraints.push(entry.constraint);
      groupIds.push(entry.groupIds);
      continue;
    }
    const existingWindow = windows[outputIndex] as PixelRect;
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
  mergeLocalMask(data, projectWindowMask(right, bounds));
  return { bounds, data };
}

function unionRects(left: PixelRect, right: PixelRect): PixelRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.w, right.x + right.w);
  const bottomEdge = Math.max(left.y + left.h, right.y + right.h);
  return { x, y, w: rightEdge - x, h: bottomEdge - y };
}

function mergeLocalMask(target: Uint8Array, source: Uint8Array): void {
  for (let index = 0; index < target.length; index += 1) {
    if (source[index]) target[index] = 1;
  }
}
