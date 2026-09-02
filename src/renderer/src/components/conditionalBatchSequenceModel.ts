export function createConditionalBatchSequenceItemId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function moveConditionalBatchSequenceItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
