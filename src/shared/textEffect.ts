import { z } from "zod";
import type { TextEffect } from "./textTypes";

export const MIN_TEXT_EFFECT_OFFSET_PX = -64;
export const MAX_TEXT_EFFECT_OFFSET_PX = 64;
export const MIN_TEXT_EFFECT_BLUR_PX = 0;
export const MAX_TEXT_EFFECT_BLUR_PX = 64;
export const TEXT_EFFECT_LENGTH_STEP_PX = 0.5;
const MIN_TEXT_EFFECT_OPACITY = 0;
const MAX_TEXT_EFFECT_OPACITY = 1;

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const finiteTextEffectNumber = z.number().finite();

export const TextEffectSchema = z
  .object({
    enabled: z.boolean(),
    color: z.string().regex(HEX_COLOR_PATTERN),
    offsetXpx: finiteTextEffectNumber
      .min(MIN_TEXT_EFFECT_OFFSET_PX)
      .max(MAX_TEXT_EFFECT_OFFSET_PX),
    offsetYpx: finiteTextEffectNumber
      .min(MIN_TEXT_EFFECT_OFFSET_PX)
      .max(MAX_TEXT_EFFECT_OFFSET_PX),
    blurPx: finiteTextEffectNumber
      .min(MIN_TEXT_EFFECT_BLUR_PX)
      .max(MAX_TEXT_EFFECT_BLUR_PX),
    opacity: finiteTextEffectNumber
      .min(MIN_TEXT_EFFECT_OPACITY)
      .max(MAX_TEXT_EFFECT_OPACITY),
  })
  .strict();

export const DEFAULT_TEXT_EFFECT: Readonly<TextEffect> = Object.freeze({
  enabled: false,
  color: "#000000",
  offsetXpx: 2,
  offsetYpx: 2,
  blurPx: 4,
  opacity: 0.5,
});

export type TextEffectScale = {
  x: number;
  y: number;
};

export function normalizeTextEffect(value: unknown): TextEffect | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : DEFAULT_TEXT_EFFECT.enabled,
    color: normalizeColor(record.color),
    offsetXpx: normalizeNumber(
      record.offsetXpx,
      MIN_TEXT_EFFECT_OFFSET_PX,
      MAX_TEXT_EFFECT_OFFSET_PX,
      DEFAULT_TEXT_EFFECT.offsetXpx,
    ),
    offsetYpx: normalizeNumber(
      record.offsetYpx,
      MIN_TEXT_EFFECT_OFFSET_PX,
      MAX_TEXT_EFFECT_OFFSET_PX,
      DEFAULT_TEXT_EFFECT.offsetYpx,
    ),
    blurPx: normalizeNumber(
      record.blurPx,
      MIN_TEXT_EFFECT_BLUR_PX,
      MAX_TEXT_EFFECT_BLUR_PX,
      DEFAULT_TEXT_EFFECT.blurPx,
    ),
    opacity: normalizeNumber(
      record.opacity,
      MIN_TEXT_EFFECT_OPACITY,
      MAX_TEXT_EFFECT_OPACITY,
      DEFAULT_TEXT_EFFECT.opacity,
    ),
  };
}

export function resolveTextEffect(value: unknown): TextEffect {
  return normalizeTextEffect(value) ?? { ...DEFAULT_TEXT_EFFECT };
}

export function cloneTextEffect(value: TextEffect): TextEffect {
  return { ...value };
}

export function resolveTextEffectFilter(
  value: unknown,
  scale: TextEffectScale = { x: 1, y: 1 },
): string | undefined {
  const effect = normalizeTextEffect(value);
  if (!effect?.enabled || effect.opacity <= 0) return undefined;
  const scaleX = normalizeScale(scale.x);
  const scaleY = normalizeScale(scale.y);
  const blurScale = (scaleX + scaleY) / 2;
  const [red, green, blue] = [
    effect.color.slice(1, 3),
    effect.color.slice(3, 5),
    effect.color.slice(5, 7),
  ].map((channel) => Number.parseInt(channel, 16));
  return `drop-shadow(${formatCssNumber(effect.offsetXpx * scaleX)}px ${formatCssNumber(effect.offsetYpx * scaleY)}px ${formatCssNumber(effect.blurPx * blurScale)}px rgba(${red}, ${green}, ${blue}, ${effect.opacity}))`;
}

function normalizeColor(value: unknown): string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : DEFAULT_TEXT_EFFECT.color;
}

function normalizeNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function normalizeScale(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function formatCssNumber(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}
