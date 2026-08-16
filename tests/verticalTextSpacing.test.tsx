/** @vitest-environment jsdom */

import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextWithVerticalSpacing } from "../src/renderer/src/components/VerticalTextSpacing";
import {
  resolveVerticalGraphemeAdvancePx,
  segmentVerticalTextGraphemes,
  tokenizeVerticalTextSpacing,
} from "../src/renderer/src/lib/verticalTextSpacing";
import {
  VERTICAL_WAVE_GLYPH_PATH,
  VERTICAL_WAVE_GLYPH_TRANSFORM,
} from "../src/renderer/src/lib/verticalTextSpacing";
import { measureUniformStyledWrappedText } from "../src/renderer/src/lib/overlayTextWrapping";

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

  it("tokenizes vertical punctuation without changing its source text", () => {
    const source = "…⋯—―〜～∼♡♥♪♬!! !? ?! ??";
    const tokens = tokenizeVerticalTextSpacing(source);

    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(
      tokens
        .filter((token) => token.kind === "ellipsis")
        .map((token) => token.displayText),
    ).toEqual(["︙", "︙"]);
    expect(tokens.find((token) => token.text === "—―")?.kind).toBe("dash");
    expect(
      tokens
        .filter((token) => token.kind === "rotate")
        .map((token) => token.displayText),
    ).toEqual(["︴", "︴", "︴"]);
    expect(tokens.filter((token) => token.kind === "combine")).toEqual([]);
    expect(
      tokenizeVerticalTextSpacing("!! !? ?! ??", true)
        .filter((token) => token.kind === "combine")
        .map((token) => token.text),
    ).toEqual(["!!", "!?", "?!", "??"]);
    expect(segmentVerticalTextGraphemes("가!!나", true)).toEqual([
      "가",
      "!!",
      "나",
    ]);
    expect(segmentVerticalTextGraphemes("가!!나")).toEqual([
      "가",
      "!",
      "!",
      "나",
    ]);
  });

  it("keeps consecutive dashes in one centered vertical run", () => {
    const { container } = render(
      <TextWithVerticalSpacing direction="vertical" text="가——나" />,
    );
    const dash = container.querySelector<HTMLElement>(
      '[data-vertical-symbol="dash"]',
    );

    expect(dash?.textContent).toBe("");
    expect(dash?.dataset.verticalSource).toBe("——");
    expect(dash?.dataset.verticalPresentation).toBe("dash");
    expect(dash?.style.inlineSize).toBe("2em");
    expect(dash?.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 100 200",
    );
    expect(dash?.querySelector("path")?.getAttribute("d")).toBe("M50 0V200");
    expect(segmentVerticalTextGraphemes("가——나")).toEqual([
      "가",
      "—",
      "—",
      "나",
    ]);
  });

  it("makes a centered dash thicker for a bold text run", () => {
    const { container } = render(
      <>
        <TextWithVerticalSpacing direction="vertical" text="—" />
        <TextWithVerticalSpacing bold direction="vertical" text="—" />
      </>,
    );
    const dashStrokes = container.querySelectorAll<SVGPathElement>(
      '[data-vertical-presentation="dash"] path:last-child',
    );

    expect(dashStrokes[0]?.style.strokeWidth).toBe("0.055em");
    expect(dashStrokes[1]?.style.strokeWidth).toBe("0.085em");
  });

  it("uses dedicated vertical presentation forms and explicit combination", () => {
    const { container } = render(
      <TextWithVerticalSpacing
        combineUpright
        direction="vertical"
        text="…—!!♡"
      />,
    );

    expect(container.textContent).toBe("!!♡");
    const ellipsis = container.querySelector<HTMLElement>(
      '[data-vertical-presentation="ellipsis"]',
    );
    expect(ellipsis?.dataset.verticalSource).toBe("…");
    expect(ellipsis?.querySelectorAll("path")).toHaveLength(2);
    expect(
      container
        .querySelector<HTMLElement>('[data-vertical-symbol="dash"]')
        ?.querySelector("path")
        ?.getAttribute("d"),
    ).toBe("M50 0V100");
    expect(
      container.querySelector<HTMLElement>('[data-vertical-symbol="combine"]')
        ?.style.textCombineUpright,
    ).toBe("all");
    expect(
      container.querySelector<HTMLElement>('[data-vertical-symbol="upright"]')
        ?.style.textOrientation,
    ).toBe("upright");
  });

  it("measures a two-mark combination as one vertical cell", () => {
    const measured = measureUniformStyledWrappedText(
      [
        { text: "가", bold: false, italic: false },
        {
          text: "!!",
          bold: false,
          italic: false,
          verticalCombine: true,
        },
        { text: "나", bold: false, italic: false },
      ],
      30,
      10,
      10,
      "break-all",
      (grapheme) => resolveVerticalGraphemeAdvancePx(grapheme, 10, 10, 0),
      undefined,
      (text, run) =>
        segmentVerticalTextGraphemes(text, run.verticalCombine === true),
    );

    expect(measured.lineCount).toBe(1);
    expect(measured.lines[0]?.runs.map((run) => run.text).join("")).toBe(
      "가!!나",
    );
    expect(measured.lines[0]?.runs[1]?.verticalCombine).toBe(true);
  });

  it("maps wave variants to one consistent vertical presentation glyph", () => {
    const { container } = render(
      <TextWithVerticalSpacing direction="vertical" text="∼～" />,
    );
    const symbols = container.querySelectorAll<HTMLElement>(
      '[data-vertical-symbol="rotate"]',
    );

    expect(symbols).toHaveLength(2);
    for (const symbol of symbols) {
      expect(symbol.dataset.verticalPresentation).toBe("wave");
      expect(symbol.querySelector("path")?.getAttribute("d")).toBe(
        VERTICAL_WAVE_GLYPH_PATH,
      );
      expect(symbol.querySelector("path")?.getAttribute("transform")).toBe(
        VERTICAL_WAVE_GLYPH_TRANSFORM,
      );
    }
  });

  it("uses the same wave shape regardless of the surrounding font", () => {
    const { container } = render(
      <>
        <span style={{ fontFamily: "serif" }}>
          <TextWithVerticalSpacing direction="vertical" text="〜" />
        </span>
        <span style={{ fontFamily: "cursive" }}>
          <TextWithVerticalSpacing direction="vertical" text="〜" />
        </span>
      </>,
    );
    const paths = Array.from(
      container.querySelectorAll<SVGPathElement>(
        '[data-vertical-presentation="wave"] path:last-child',
      ),
      (path) => path.getAttribute("d"),
    );

    expect(paths).toEqual([VERTICAL_WAVE_GLYPH_PATH, VERTICAL_WAVE_GLYPH_PATH]);
  });
});
