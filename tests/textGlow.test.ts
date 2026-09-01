import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_GLOW,
  TextGlowSchema,
  cloneTextGlow,
  normalizeTextGlow,
  resolveTextGlow,
  resolveTextGlowCssShadow,
} from "../src/shared/textGlow";

describe("text glow formatting", () => {
  it("validates and normalizes persisted glow values", () => {
    const glow = {
      enabled: true,
      color: "#AABBCC",
      blurPx: 6.5,
      opacity: 0.7,
    };
    expect(TextGlowSchema.safeParse(glow).success).toBe(true);
    expect(normalizeTextGlow(glow)).toEqual({
      ...glow,
      color: "#aabbcc",
    });
    expect(normalizeTextGlow({ ...glow, blurPx: 65 })).toBeUndefined();
    expect(resolveTextGlow(undefined)).toEqual(DEFAULT_TEXT_GLOW);
  });

  it("clones glow values and emits a centered CSS glow", () => {
    const glow = {
      enabled: true,
      color: "#123456",
      blurPx: 8,
      opacity: 0.5,
    } as const;
    const cloned = cloneTextGlow(glow);
    expect(cloned).toEqual(glow);
    expect(cloned).not.toBe(glow);
    expect(resolveTextGlowCssShadow(glow)).toBe(
      "0 0 8px rgba(18, 52, 86, 0.5)",
    );
    expect(resolveTextGlowCssShadow(glow, 0.5)).toBe(
      "0 0 4px rgba(18, 52, 86, 0.5)",
    );
    expect(
      resolveTextGlowCssShadow({ ...glow, enabled: false }),
    ).toBeUndefined();
  });
});
