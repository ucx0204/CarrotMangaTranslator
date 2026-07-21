// @vitest-environment jsdom

import { Script, type Context } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { PAGE_EXPORT_DOM_SCRIPT } from "../src/main/pageExportDomScript";
import type { PageExportBlock } from "../src/main/pageExportBlocks";

beforeAll(() => {
  const measurementContext = {
    font: "",
    measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
  };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => measurementContext,
  });
});

describe("PAGE_EXPORT_DOM_SCRIPT", () => {
  it("remains valid JavaScript after transform renderer changes", () => {
    expect(() => new Script(PAGE_EXPORT_DOM_SCRIPT)).not.toThrow();
  });

  it("keeps a normal block on the legacy DOM path", () => {
    const stage = renderExportDom([makeExportBlock()]);
    const outer = stage.querySelector<HTMLElement>(".overlay-block");

    expect(outer?.firstElementChild?.classList.contains("overlay-text")).toBe(
      true,
    );
    expect(outer?.querySelector(".overlay-perspective-layer")).toBeNull();
    expect(outer?.querySelector("svg")).toBeNull();
    expect(outer?.querySelector(".overlay-text-content")?.textContent).toBe(
      "AB",
    );
  });

  it("renders distinct fixed lines for each horizontal wrapping mode", () => {
    const expected = {
      normal: ["ab ", "cdefgh"],
      "break-all": ["ab cd", "efgh"],
      "keep-all": ["ab ", "cdefgh"],
      "break-word": ["ab ", "cdefg", "h"],
    } as const;

    for (const [wordBreak, lines] of Object.entries(expected)) {
      const stage = renderExportDom([
        makeExportBlock({
          text: "ab cdefgh",
          runs: [{ text: "ab cdefgh", bold: false, italic: false }],
          rect: { left: 0, top: 0, width: 50, height: 100 },
          fontWidthScale: 1,
          letterSpacing: 0,
          wordBreak: wordBreak as PageExportBlock["wordBreak"],
        }),
      ]);

      expect(renderedLineTexts(stage)).toEqual(lines);
      expect(textContentFor(stage)?.style.wordBreak).toBe(wordBreak);
    }
  });

  it("keeps the legacy direction-specific wrapping fallbacks", () => {
    const horizontalBlock = makeExportBlock({
      text: "ab cdefgh",
      runs: [{ text: "ab cdefgh", bold: false, italic: false }],
      rect: { left: 0, top: 0, width: 50, height: 100 },
      fontWidthScale: 1,
      letterSpacing: 0,
    });
    const verticalBlock = makeExportBlock({ renderDirection: "vertical" });
    delete (horizontalBlock as Partial<PageExportBlock>).wordBreak;
    delete (verticalBlock as Partial<PageExportBlock>).wordBreak;

    const horizontal = renderExportDom([horizontalBlock]);
    const vertical = renderExportDom([verticalBlock]);

    expect(renderedLineTexts(horizontal)).toEqual(["ab cd", "efgh"]);
    expect(textContentFor(horizontal)?.style.wordBreak).toBe("break-all");
    expect(textContentFor(horizontal)?.style.overflowWrap).toBe("normal");
    expect(textContentFor(vertical)?.style.wordBreak).toBe("break-word");
    expect(textContentFor(vertical)?.style.overflowWrap).toBe("anywhere");
    expect(vertical.querySelector(".overlay-text-line")).toBeNull();
  });

  it("keeps unspaced CJK together only in the keep-together mode", () => {
    const normal = renderExportDom([
      makeExportBlock({
        text: "가나다라마",
        runs: [{ text: "가나다라마", bold: false, italic: false }],
        rect: { left: 0, top: 0, width: 30, height: 100 },
        fontWidthScale: 1,
        letterSpacing: 0,
        wordBreak: "normal",
      }),
    ]);
    expect(renderedLineTexts(normal)).toEqual(["가나다", "라마"]);

    const keepAll = renderExportDom([
      makeExportBlock({
        text: "가나다라마",
        runs: [{ text: "가나다라마", bold: false, italic: false }],
        rect: { left: 0, top: 0, width: 30, height: 100 },
        fontWidthScale: 1,
        letterSpacing: 0,
        wordBreak: "keep-all",
      }),
    ]);
    expect(renderedLineTexts(keepAll)).toEqual(["가나다라마"]);
  });

  it("uses language-aware export breaks for text without spaces", () => {
    const stage = renderExportDom([
      makeExportBlock({
        text: "ภาษาไทย",
        runs: [{ text: "ภาษาไทย", bold: false, italic: false }],
        rect: { left: 0, top: 0, width: 40, height: 100 },
        fontWidthScale: 1,
        letterSpacing: 0,
        wordBreak: "normal",
      }),
    ]);

    expect(renderedLineTexts(stage)).toEqual(["ภาษา", "ไทย"]);
  });

  it("does not invent a line opportunity at a rich-style run boundary", () => {
    const stage = renderExportDom([
      makeExportBlock({
        text: "abcdef",
        runs: [
          { text: "abc", bold: true, italic: false },
          { text: "def", bold: false, italic: true },
        ],
        rect: { left: 0, top: 0, width: 40, height: 100 },
        fontWidthScale: 1,
        letterSpacing: 0,
        wordBreak: "normal",
      }),
    ]);
    const line = stage.querySelector<HTMLElement>(".overlay-text-line");

    expect(renderedLineTexts(stage)).toEqual(["abcdef"]);
    expect(line?.children).toHaveLength(2);
    expect(
      (line?.children[0] as HTMLElement | undefined)?.style.fontWeight,
    ).toBe("800");
    expect(
      (line?.children[1] as HTMLElement | undefined)?.style.fontStyle,
    ).toBe("italic");
  });

  it("uses the wrapping mode during auto-fit measurement", () => {
    const base = {
      text: "abcdef",
      runs: [{ text: "abcdef", bold: false, italic: false }],
      rect: { left: 0, top: 0, width: 30, height: 100 },
      fontWidthScale: 1,
      letterSpacing: 0,
      lineHeight: 1,
      autoFitText: true,
    } satisfies Partial<PageExportBlock>;
    const normal = renderExportDom([
      makeExportBlock({ ...base, wordBreak: "normal" }),
    ]);
    const emergency = renderExportDom([
      makeExportBlock({ ...base, wordBreak: "break-word" }),
    ]);

    expect(textWrapFor(normal)?.style.fontSize).toBe("10px");
    expect(
      Number.parseFloat(textWrapFor(emergency)?.style.fontSize ?? "0"),
    ).toBeGreaterThan(10);
  });

  it("applies the selected vertical CSS and matching overflow fallback", () => {
    const keepAll = renderExportDom([
      makeExportBlock({ renderDirection: "vertical", wordBreak: "keep-all" }),
    ]);
    expect(textContentFor(keepAll)?.style.wordBreak).toBe("keep-all");
    expect(textContentFor(keepAll)?.style.overflowWrap).toBe("normal");

    const emergency = renderExportDom([
      makeExportBlock({
        renderDirection: "vertical",
        wordBreak: "break-word",
      }),
    ]);
    expect(textContentFor(emergency)?.style.wordBreak).toBe("break-word");
    expect(textContentFor(emergency)?.style.overflowWrap).toBe("anywhere");
    expect(emergency.querySelector(".overlay-text-line")).toBeNull();
  });

  it("renders curve glyphs inside perspective and rotation without guides", () => {
    const stage = renderExportDom([
      makeExportBlock({
        rotationDeg: 135,
        perspectiveMatrix3d:
          "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1)",
        curveLayout: {
          alignment: "center",
          offsetEm: 0.5,
          orientation: "tangent",
          fitSpacing: false,
          pathLength: 100,
          samples: [
            {
              distance: 0,
              x: 0,
              y: 50,
              tangentX: 1,
              tangentY: 0,
            },
            {
              distance: 100,
              x: 100,
              y: 50,
              tangentX: 1,
              tangentY: 0,
            },
          ],
        },
      }),
    ]);
    const outer = stage.querySelector<HTMLElement>(".overlay-block");
    const perspective = outer?.firstElementChild as HTMLElement | null;
    const svg = perspective?.firstElementChild as SVGSVGElement | null;
    const glyphs = svg?.querySelectorAll("text");

    expect(outer?.style.transform).toBe("rotate(135deg)");
    expect(perspective?.classList.contains("overlay-perspective-layer")).toBe(
      true,
    );
    expect(perspective?.style.transform).toContain("matrix3d(");
    expect(perspective?.style.transformOrigin).toBe("top left");
    expect(perspective?.style.transformStyle).toBe("preserve-3d");
    expect(svg?.classList.contains("curve-text-layer")).toBe(true);
    expect(svg?.style.opacity).toBe("0.42");
    expect(glyphs).toHaveLength(2);
    expect(glyphs?.[0].style.fontWeight).toBe("800");
    expect(glyphs?.[1].style.fontStyle).toBe("italic");
    expect(glyphs?.[0].getAttribute("paint-order")).toBe("stroke fill");
    expect(glyphs?.[0].getAttribute("transform")).toContain("scale(1.2 1)");
    expect(svg?.querySelector("path, line, circle, rect")).toBeNull();
  });

  it("keeps multiline curve data but falls back to regular text DOM", () => {
    const stage = renderExportDom([
      makeExportBlock({
        text: "A\nB",
        runs: [{ text: "A\nB", bold: false, italic: false }],
        curveLayout: {
          alignment: "start",
          offsetEm: 0,
          orientation: "upright",
          fitSpacing: false,
          pathLength: 100,
          samples: [
            {
              distance: 0,
              x: 0,
              y: 50,
              tangentX: 1,
              tangentY: 0,
            },
            {
              distance: 100,
              x: 100,
              y: 50,
              tangentX: 1,
              tangentY: 0,
            },
          ],
        },
      }),
    ]);

    expect(stage.querySelector("svg")).toBeNull();
    expect(stage.querySelector(".overlay-text-content")?.textContent).toBe(
      "AB",
    );
  });
});

function makeExportBlock(
  overrides: Partial<PageExportBlock> = {},
): PageExportBlock {
  return {
    type: "nonsolid",
    text: "AB",
    runs: [
      { text: "A", bold: true, italic: false },
      { text: "B", bold: false, italic: true },
    ],
    rect: { left: 10, top: 20, width: 100, height: 100 },
    renderDirection: "horizontal",
    rotationDeg: 0,
    fontFamily: "sans-serif",
    fontSizePx: 24,
    lineHeight: 1.18,
    letterSpacing: 0.1,
    fontWidthScale: 1.2,
    wordBreak: "normal",
    textAlign: "center",
    textColor: "#111111",
    textOpacity: 0.42,
    outlineColor: "#ffffff",
    bold: false,
    italic: false,
    outlineWidthScale: 1,
    autoFitText: false,
    ...overrides,
  };
}

function renderExportDom(blocks: PageExportBlock[]): HTMLElement {
  document.body.innerHTML = '<div id="stage"></div>';
  const context: Context & { document: Document; window: Window } = {
    document,
    window,
    console,
    Intl,
    Math,
    Number,
    Object,
    String,
    Array,
    Promise,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  };
  const source = `
const EXPORT_BLOCKS = ${JSON.stringify(blocks)};
const EXPORT_IMAGE_DATA_URL = "";
const EXPORT_PAGE_NAME = "";
${PAGE_EXPORT_DOM_SCRIPT}
const exportStage = document.getElementById("stage");
const renderedForTest = renderExportBlocks(exportStage);
applyAllTextLayouts(renderedForTest);
`;
  new Script(source).runInNewContext(context);
  const stage = document.getElementById("stage");
  if (!stage) {
    throw new Error("Export stage was not rendered.");
  }
  return stage;
}

function renderedLineTexts(stage: HTMLElement): string[] {
  return Array.from(
    stage.querySelectorAll(".overlay-text-line"),
    (line) => line.textContent ?? "",
  );
}

function textContentFor(stage: HTMLElement): HTMLElement | null {
  return stage.querySelector<HTMLElement>(".overlay-text-content");
}

function textWrapFor(stage: HTMLElement): HTMLElement | null {
  return stage.querySelector<HTMLElement>(".overlay-text");
}
