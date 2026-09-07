import { describe, expect, it, vi } from "vitest";
import { renderFontSamples } from "../src/main/pipeline/codexTypesettingRaster";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { PageExportLayoutEvidence } from "../src/shared/pageExportContracts";
import { parseRichText } from "../src/shared/richTextMarkup";
import { segmentNaturalTextGraphemes } from "../src/shared/naturalTextLayoutSegmentation";

vi.mock("electron", () => ({ nativeImage: {} }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  writeFile: vi.fn(),
}));
const options = {
  version: 1 as const,
  preset: {
    id: "qa",
    name: "custom",
    fonts: [{ fontId: "custom", purpose: "natural handwriting" }],
  },
};

function renderer(limit: number) {
  let page: MangaPage;
  return {
    close: () => {},
    renderPage: vi.fn(async (next: MangaPage) => {
      page = next;
      return Buffer.from("renderer-bytes");
    }),
    inspectLastLayout: vi.fn(
      async (): Promise<PageExportLayoutEvidence> =>
        page.blocks.map((block) => ({
          blockId: block.id,
          lines: [parseRichText(block.translatedText).plainText],
          fontSizePx: block.fontSizePx,
          innerWidth: 564,
          innerHeight: 180,
          overflow:
            segmentNaturalTextGraphemes(
              parseRichText(block.translatedText).plainText,
            ).length > limit,
        })),
    ),
  };
}

describe("actual-size font sample inputs", () => {
  it("keeps the existing six sizes/weights while shortening only the specimen at grapheme boundaries", async () => {
    const render = renderer(8);
    const sample = "e\u0301👨‍👩‍👧‍👦 가나다라마바 사아자차카타파하";
    const images = await renderFontSamples(
      options,
      sample,
      "unused-test-output",
      render,
    );
    expect(render.renderPage).toHaveBeenCalledTimes(1);
    const page = render.renderPage.mock.calls[0][0];
    expect(page.blocks.map((block) => [block.fontSizePx, block.bold])).toEqual([
      [24, false],
      [24, true],
      [40, false],
      [40, true],
      [60, false],
      [60, true],
    ]);
    const expected = segmentNaturalTextGraphemes(sample).slice(0, 8).join("");
    expect(
      page.blocks.every(
        (block) =>
          parseRichText(block.translatedText).plainText === expected &&
          block.fontFamily === "custom" &&
          block.autoFitText === false,
      ),
    ).toBe(true);
    expect(render.inspectLastLayout).toHaveBeenCalledTimes(1);
    expect(images[0].label).toContain("24px,40px,60px");
  });

  it("shortens an unusually wide custom specimen instead of shrinking its stated point sizes", async () => {
    const render = renderer(4);
    await renderFontSamples(
      options,
      "아주 긴 한국어 견본 문구",
      "unused-test-output",
      render,
    );
    expect(
      render.renderPage.mock.calls.map(
        ([page]) =>
          segmentNaturalTextGraphemes(
            parseRichText(page.blocks[0].translatedText).plainText,
          ).length,
      ),
    ).toEqual([8, 4]);
    expect(
      render.renderPage.mock.calls.every(
        ([page]) => page.blocks[4].fontSizePx === 60,
      ),
    ).toBe(true);
  });

  it("rejects a specimen that still overflows after two repairs", async () => {
    const render = renderer(0);
    await expect(
      renderFontSamples(
        options,
        "긴 폰트 견본 문자열",
        "unused-test-output",
        render,
      ),
    ).rejects.toThrow("견본");
    expect(
      render.renderPage.mock.calls.map(
        ([page]) =>
          segmentNaturalTextGraphemes(
            parseRichText(page.blocks[0].translatedText).plainText,
          ).length,
      ),
    ).toEqual([8, 4, 1]);
  });

  it("does not send unmeasured or partially measured samples", async () => {
    const render = renderer(8);
    await expect(
      renderFontSamples(options, "가나다", "unused-test-output", {
        ...render,
        inspectLastLayout: undefined,
      }),
    ).rejects.toThrow("측정");
    render.inspectLastLayout.mockResolvedValue([]);
    await expect(
      renderFontSamples(options, "가나다", "unused-test-output", render),
    ).rejects.toThrow("Font sample");
  });

  it("renders literal markup and rejects an empty specimen", async () => {
    const render = renderer(8);
    await renderFontSamples(options, "**AB**", "unused-test-output", render);
    expect(
      parseRichText(render.renderPage.mock.calls[0][0].blocks[0].translatedText)
        .plainText,
    ).toBe("**AB**");
    await expect(
      renderFontSamples(options, " \n ", "unused-test-output", render),
    ).rejects.toThrow("견본");
  });
});
