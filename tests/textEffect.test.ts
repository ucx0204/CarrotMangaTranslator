import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_EFFECT,
  TextEffectSchema,
  cloneTextEffect,
  normalizeTextEffect,
  resolveTextEffect,
  resolveTextEffectFilter,
} from "../src/shared/textEffect";

describe("text shadow and glow formatting", () => {
  it("accepts only complete, bounded persisted effect records", () => {
    const effect = {
      enabled: true,
      color: "#2a4c8e",
      offsetXpx: -64,
      offsetYpx: 64,
      blurPx: 32.5,
      opacity: 0.65,
    };
    expect(TextEffectSchema.parse(effect)).toEqual(effect);

    for (const invalidEffect of [
      { ...effect, color: "blue" },
      { ...effect, offsetXpx: -64.5 },
      { ...effect, offsetYpx: 64.5 },
      { ...effect, blurPx: -0.5 },
      { ...effect, opacity: 1.01 },
      { ...effect, extra: true },
    ]) {
      expect(TextEffectSchema.safeParse(invalidEffect).success).toBe(false);
    }
  });

  it("normalizes valid values and clamps persisted numeric fields", () => {
    expect(
      normalizeTextEffect({
        enabled: true,
        color: "#ABCDEF",
        offsetXpx: -100,
        offsetYpx: 100,
        blurPx: 100,
        opacity: -1,
      }),
    ).toEqual({
      enabled: true,
      color: "#abcdef",
      offsetXpx: -64,
      offsetYpx: 64,
      blurPx: 64,
      opacity: 0,
    });
  });

  it("falls back field by field without accepting malformed records", () => {
    expect(normalizeTextEffect(null)).toBeUndefined();
    expect(normalizeTextEffect([])).toBeUndefined();
    expect(normalizeTextEffect("shadow")).toBeUndefined();
    expect(
      normalizeTextEffect({
        enabled: "yes",
        color: "red",
        offsetXpx: Number.NaN,
        offsetYpx: "2",
        blurPx: undefined,
        opacity: Number.POSITIVE_INFINITY,
      }),
    ).toEqual(DEFAULT_TEXT_EFFECT);
    expect(resolveTextEffect(undefined)).toEqual(DEFAULT_TEXT_EFFECT);
  });

  it("clones values and emits one post-composition drop shadow filter", () => {
    const effect = {
      enabled: true,
      color: "#123456",
      offsetXpx: -2.5,
      offsetYpx: 3,
      blurPx: 7.5,
      opacity: 0.65,
    } as const;
    const cloned = cloneTextEffect(effect);

    expect(cloned).toEqual(effect);
    expect(cloned).not.toBe(effect);
    expect(resolveTextEffectFilter(effect)).toBe(
      "drop-shadow(-2.5px 3px 7.5px rgba(18, 52, 86, 0.65))",
    );
    expect(resolveTextEffectFilter(effect, { x: 0.5, y: 0.25 })).toBe(
      "drop-shadow(-1.25px 0.75px 2.8125px rgba(18, 52, 86, 0.65))",
    );
    expect(resolveTextEffectFilter(effect, { x: Number.NaN, y: 0 })).toBe(
      "drop-shadow(-2.5px 3px 7.5px rgba(18, 52, 86, 0.65))",
    );
    expect(
      resolveTextEffectFilter({ ...effect, enabled: false }),
    ).toBeUndefined();
    expect(resolveTextEffectFilter({ ...effect, opacity: 0 })).toBeUndefined();
    expect(resolveTextEffectFilter(undefined)).toBeUndefined();
  });
});
