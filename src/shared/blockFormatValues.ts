export const MIN_FONT_SIZE_PX = 1;
export const MAX_FONT_SIZE_PX = 512;
export const FONT_SIZE_STEP_PX = 0.5;

export const MIN_LINE_HEIGHT = 0.1;
export const MAX_LINE_HEIGHT = 10;
export const LINE_HEIGHT_STEP = 0.01;

export const MIN_LETTER_SPACING_EM = -1;
export const MAX_LETTER_SPACING_EM = 5;
export const LETTER_SPACING_STEP_EM = 0.01;

export const MIN_FONT_WIDTH_SCALE = 0.1;
export const MAX_FONT_WIDTH_SCALE = 5;
export const FONT_WIDTH_SCALE_STEP = 0.01;

export function clampFontSizePx(value: number, fallback = 24): number {
  return clampStepped(
    value,
    MIN_FONT_SIZE_PX,
    MAX_FONT_SIZE_PX,
    FONT_SIZE_STEP_PX,
    fallback,
  );
}

export function clampLineHeight(value: number, fallback = 1.18): number {
  return clampStepped(
    value,
    MIN_LINE_HEIGHT,
    MAX_LINE_HEIGHT,
    LINE_HEIGHT_STEP,
    fallback,
  );
}

export function clampLetterSpacingEm(value: number, fallback = 0): number {
  return clampStepped(
    value,
    MIN_LETTER_SPACING_EM,
    MAX_LETTER_SPACING_EM,
    LETTER_SPACING_STEP_EM,
    fallback,
  );
}

export function clampFontWidthScale(value: number, fallback = 1): number {
  return clampStepped(
    value,
    MIN_FONT_WIDTH_SCALE,
    MAX_FONT_WIDTH_SCALE,
    FONT_WIDTH_SCALE_STEP,
    fallback,
  );
}

export function clampBlockFormatNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  const numeric = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function clampStepped(
  value: number,
  min: number,
  max: number,
  step: number,
  fallback: number,
): number {
  const clamped = clampBlockFormatNumber(value, min, max, fallback);
  const precision = resolveStepPrecision(step);
  const scale = 10 ** precision;
  const stepped = min + Math.round((clamped - min) / step) * step;
  return Math.round(Math.min(max, Math.max(min, stepped)) * scale) / scale;
}

function resolveStepPrecision(step: number): number {
  const text = String(step);
  const decimal = text.split(".")[1];
  return decimal?.length ?? 0;
}
