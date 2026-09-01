import { z } from "zod";
import type { TextGlow } from "./textTypes";

export const MIN_TEXT_GLOW_BLUR_PX = 0;
export const MAX_TEXT_GLOW_BLUR_PX = 64;
export const TEXT_GLOW_BLUR_STEP_PX = 0.5;

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export const TextGlowSchema = z
  .object({
    enabled: z.boolean(),
    color: z.string().regex(HEX_COLOR_PATTERN),
    blurPx: z.number().finite().min(0).max(MAX_TEXT_GLOW_BLUR_PX),
    opacity: z.number().finite().min(0).max(1),
  })
  .strict();

export const DEFAULT_TEXT_GLOW: Readonly<TextGlow> = Object.freeze({
  enabled: false,
  color: "#ffffff",
  blurPx: 4,
  opacity: 0.75,
});

export function normalizeTextGlow(value: unknown): TextGlow | undefined {
  const result = TextGlowSchema.safeParse(value);
  if (!result.success) return undefined;
  return {
    ...result.data,
    color: result.data.color.toLowerCase(),
  };
}

export function resolveTextGlow(value: unknown): TextGlow {
  return normalizeTextGlow(value) ?? { ...DEFAULT_TEXT_GLOW };
}

export function cloneTextGlow(value: TextGlow): TextGlow {
  return { ...value };
}

export function resolveTextGlowCssShadow(
  value: unknown,
  scale = 1,
): string | undefined {
  const glow = normalizeTextGlow(value);
  if (!glow?.enabled || glow.opacity <= 0 || glow.blurPx <= 0) {
    return undefined;
  }
  const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const red = Number.parseInt(glow.color.slice(1, 3), 16);
  const green = Number.parseInt(glow.color.slice(3, 5), 16);
  const blue = Number.parseInt(glow.color.slice(5, 7), 16);
  const blur = Math.round(glow.blurPx * normalizedScale * 1000) / 1000;
  return `0 0 ${blur}px rgba(${red}, ${green}, ${blue}, ${glow.opacity})`;
}
