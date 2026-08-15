import React from "react";

type Listener = () => void;

const selections = new Map<string, readonly number[]>();
const listeners = new Map<string, Set<Listener>>();
const EMPTY_SELECTION: readonly number[] = [];

export function useWarpPointSelection(
  blockId: string,
  pointCount: number,
): [readonly number[], (indexes: readonly number[]) => void] {
  const subscribe = React.useCallback(
    (listener: Listener) => subscribeWarpPointSelection(blockId, listener),
    [blockId],
  );
  const getSnapshot = React.useCallback(
    () => getWarpPointSelection(blockId),
    [blockId],
  );
  const selected = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const setSelected = React.useCallback(
    (indexes: readonly number[]) =>
      setWarpPointSelection(blockId, indexes, pointCount),
    [blockId, pointCount],
  );
  React.useEffect(() => {
    const sanitized = sanitizeIndexes(selected, pointCount);
    if (!sameIndexes(selected, sanitized)) setSelected(sanitized);
  }, [pointCount, selected, setSelected]);
  return [selected, setSelected];
}

function getWarpPointSelection(blockId: string): readonly number[] {
  return selections.get(blockId) ?? EMPTY_SELECTION;
}

function setWarpPointSelection(
  blockId: string,
  indexes: readonly number[],
  pointCount: number,
): void {
  const next = sanitizeIndexes(indexes, pointCount);
  const current = getWarpPointSelection(blockId);
  if (sameIndexes(current, next)) return;
  if (next.length > 0) selections.set(blockId, next);
  else selections.delete(blockId);
  for (const listener of listeners.get(blockId) ?? []) listener();
}

function subscribeWarpPointSelection(
  blockId: string,
  listener: Listener,
): () => void {
  const blockListeners = listeners.get(blockId) ?? new Set<Listener>();
  blockListeners.add(listener);
  listeners.set(blockId, blockListeners);
  return () => {
    blockListeners.delete(listener);
    if (blockListeners.size === 0) listeners.delete(blockId);
  };
}

function sanitizeIndexes(
  indexes: readonly number[],
  pointCount: number,
): readonly number[] {
  return Array.from(
    new Set(
      indexes.filter(
        (index) => Number.isInteger(index) && index >= 0 && index < pointCount,
      ),
    ),
  ).sort((left, right) => left - right);
}

function sameIndexes(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
