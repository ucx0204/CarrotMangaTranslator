/**
 * Numeric normalization shared by the number field and its scrub controller.
 * Kept in its own module so both can import it without a cycle.
 */

export function parseNumber(raw: string): number | null {
  if (!raw.trim()) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function roundToPrecision(value: number, precision: number): number {
  const scale = 10 ** Math.max(0, precision);
  return Math.round(value * scale) / scale;
}

export function formatNumber(value: number, precision: number): string {
  return String(roundToPrecision(value, precision));
}

/** Clamps into range, optionally snaps onto the step grid, then rounds. */
export function normalizeNumberFieldValue(
  value: number,
  min: number,
  max: number,
  precision: number,
  step: number,
  snapToStep: boolean,
): number {
  const finite = Number.isFinite(value) ? value : min;
  const clamped = Math.min(max, Math.max(min, finite));
  const snapped =
    snapToStep && step > 0
      ? min + Math.round((clamped - min) / step) * step
      : clamped;
  return roundToPrecision(Math.min(max, Math.max(min, snapped)), precision);
}

/** Derives display precision from the step (0.05 -> 2 decimals). */
export function resolveStepPrecision(step: number): number {
  const decimal = String(step).split(".")[1];
  return decimal?.length ?? 0;
}
