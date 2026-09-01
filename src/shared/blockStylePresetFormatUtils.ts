import type { BlockFormatGroupId } from "./blockFormat";

export function buildFormat<Source, Output extends object>(
  source: Source,
  groupIds: readonly BlockFormatGroupId[],
  builders: Record<BlockFormatGroupId, (source: Source) => Output>,
): Output {
  return compactObject(
    Object.assign({}, ...groupIds.map((groupId) => builders[groupId](source))),
  ) as Output;
}

function compactObject<Output extends object>(value: Output): Output {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Output;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function rangedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

export function optionalRangedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : undefined;
}

export function optionalString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maximumLength);
  return normalized || undefined;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function colorValue(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : fallback;
}

export function optionalColor(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function enumValue<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && choices.includes(value as T)
    ? (value as T)
    : fallback;
}
