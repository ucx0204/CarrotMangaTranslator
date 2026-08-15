/** @vitest-environment jsdom */

import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextWithVerticalSpacing } from "../src/renderer/src/components/VerticalTextSpacing";
import {
  resolveVerticalGraphemeAdvancePx,
  tokenizeVerticalTextSpacing,
} from "../src/renderer/src/lib/verticalTextSpacing";

describe("vertical text spacing", () => {
  it("keeps source text while assigning half and full em advances", () => {
    expect(tokenizeVerticalTextSpacing("가 나　다")).toEqual([
      { text: "가" },
      { text: " ", advanceEm: 0.5, kind: "ascii" },
      { text: "나" },
      { text: "　", advanceEm: 1, kind: "ideographic" },
      { text: "다" },
    ]);
  });

  it("renders explicit vertical spacing without changing horizontal text", () => {
    const { container, rerender } = render(
      <TextWithVerticalSpacing direction="vertical" text="가 나　다" />,
    );
    expect(container.textContent).toBe("가 나　다");
    expect(
      container.querySelector<HTMLElement>('[data-vertical-space="ascii"]')
        ?.style.inlineSize,
    ).toBe("0.5em");
    expect(
      container.querySelector<HTMLElement>(
        '[data-vertical-space="ideographic"]',
      )?.style.inlineSize,
    ).toBe("1em");

    rerender(
      <TextWithVerticalSpacing direction="horizontal" text="가 나　다" />,
    );
    expect(container.querySelector("[data-vertical-space]")).toBeNull();
    expect(container.textContent).toBe("가 나　다");
  });

  it("applies negative tracking consistently to both vertical space widths", () => {
    expect(resolveVerticalGraphemeAdvancePx(" ", 20, 24, -2)).toBe(8);
    expect(resolveVerticalGraphemeAdvancePx("　", 20, 24, -2)).toBe(18);
    expect(resolveVerticalGraphemeAdvancePx("가", 20, 24, -2)).toBe(24);
  });
});
