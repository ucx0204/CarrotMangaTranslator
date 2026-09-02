export const SOURCE_FONT_FACE_SCALE = 1.02;

export function maximumValueRatio(values: readonly number[]): number {
  return values.length >= 2
    ? Math.max(...values) / Math.max(1, Math.min(...values))
    : 1;
}

export function valuePairRatio(first: number, second: number): number {
  return Math.max(first / Math.max(1, second), second / Math.max(1, first));
}

export function estimateLineCount(
  glyphCount: number,
  cross: number,
  major: number,
): number {
  if (glyphCount <= 1 || cross <= 0 || major <= 0) return 1;
  return clamp(
    Math.round(Math.sqrt((glyphCount * cross) / major)),
    1,
    maximumLineCount(glyphCount),
  );
}

export function isPlausibleLineCount(
  lineCount: number,
  glyphCount: number,
): boolean {
  return (
    Number.isInteger(lineCount) &&
    lineCount >= 1 &&
    lineCount <= maximumLineCount(glyphCount)
  );
}

export function maximumLineCount(glyphCount: number): number {
  return Math.max(1, Math.min(12, Math.ceil(glyphCount / 2)));
}

export function mean(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
