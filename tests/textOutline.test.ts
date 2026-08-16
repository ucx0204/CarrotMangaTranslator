import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_OUTLINE_WIDTH_PX,
  resolveAutomaticTextOutlineColor,
  resolveEffectiveTextOutlineWidthPx,
  snapTextOutlineWidthPx,
} from "../src/shared/textOutline";

describe("text outline width", () => {
  it("preserves the legacy font-relative scale when no pixel width exists", () => {
    expect(
      resolveEffectiveTextOutlineWidthPx({ outlineWidthScale: 1 }, 24),
    ).toBe(1.3);
    expect(
      resolveEffectiveTextOutlineWidthPx({ outlineWidthScale: 1.5 }, 100),
    ).toBe(6);
    expect(
      resolveEffectiveTextOutlineWidthPx({ outlineWidthScale: 0 }, 24),
    ).toBe(0);
  });

  it("prefers a manual pixel width independently of the font size", () => {
    const style = { outlineWidthPx: 8.5, outlineWidthScale: 0 };
    expect(resolveEffectiveTextOutlineWidthPx(style, 12)).toBe(8.5);
    expect(resolveEffectiveTextOutlineWidthPx(style, 300)).toBe(8.5);
  });

  it("clamps imported pixel widths and snaps manual edits to half pixels", () => {
    expect(resolveEffectiveTextOutlineWidthPx({ outlineWidthPx: -4 }, 24)).toBe(
      0,
    );
    expect(
      resolveEffectiveTextOutlineWidthPx({ outlineWidthPx: 100 }, 24),
    ).toBe(MAX_TEXT_OUTLINE_WIDTH_PX);
    expect(snapTextOutlineWidthPx(8.3)).toBe(8.5);
    expect(snapTextOutlineWidthPx(64.4)).toBe(64);
  });

  it("chooses a contrasting outline only when automatic matching is applied", () => {
    expect(
      resolveAutomaticTextOutlineColor({
        textColor: "#f7f7f2",
        outlineColor: "#f7f7f2",
      }),
    ).toBe("#111111");
  });
});
