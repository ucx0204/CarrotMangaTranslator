import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  applyInpaintingLayoutStates,
  captureInpaintingLayoutStates,
  pageMatchesInpaintingLayoutStates,
} from "../src/main/inpainting/inpaintingLayoutState";

describe("inpainting layout state", () => {
  it("keeps legacy states geometry-only and compares opt-in text per block", () => {
    const page = makePage();
    const firstBlock = page.blocks[0];
    if (!firstBlock) {
      throw new Error("Expected a seeded block.");
    }
    const mixedPage: Pick<MangaPage, "blocks"> = {
      blocks: [
        firstBlock,
        {
          ...structuredClone(firstBlock),
          id: "second-block",
          translatedText: "second translation",
        },
      ],
    };

    const geometryOnly = captureInpaintingLayoutStates(mixedPage, [
      "seed-block",
    ]);
    expect(geometryOnly).toEqual([
      {
        blockId: "seed-block",
        renderBbox: null,
        renderBboxSpace: null,
        bubbleLayout: null,
      },
    ]);
    expect(geometryOnly[0]).not.toHaveProperty("translatedText");

    const secondWithText = captureInpaintingLayoutStates(
      mixedPage,
      ["second-block"],
      { includeTranslatedText: true },
    );
    expect(secondWithText[0]).toHaveProperty(
      "translatedText",
      "second translation",
    );
    const geometryState = geometryOnly[0];
    const textState = secondWithText[0];
    if (!geometryState || !textState) {
      throw new Error("Expected captured layout states.");
    }
    const mixedExpected = [geometryState, textState];
    expect(pageMatchesInpaintingLayoutStates(mixedPage, mixedExpected)).toBe(
      true,
    );
    expect(
      pageMatchesInpaintingLayoutStates(
        {
          blocks: mixedPage.blocks.map((block) =>
            block.id === "seed-block"
              ? { ...block, translatedText: "ignored manual edit" }
              : block,
          ),
        },
        mixedExpected,
      ),
    ).toBe(true);
    expect(
      pageMatchesInpaintingLayoutStates(
        {
          blocks: mixedPage.blocks.map((block) =>
            block.id === "second-block"
              ? { ...block, translatedText: "conflicting edit" }
              : block,
          ),
        },
        mixedExpected,
      ),
    ).toBe(false);

    const geometryApplied = applyInpaintingLayoutStates(
      {
        blocks: page.blocks.map((block) => ({
          ...block,
          translatedText: "keep this edit",
        })),
      },
      geometryOnly,
    );
    expect(geometryApplied.blocks[0]?.translatedText).toBe("keep this edit");

    const invalidTextState = structuredClone(textState);
    Reflect.set(invalidTextState, "translatedText", 42);
    expect(() =>
      applyInpaintingLayoutStates(mixedPage, [invalidTextState]),
    ).toThrow(/번역문이 올바르지 않습니다/);
    const invalidTextPage = structuredClone(mixedPage);
    const invalidTextBlock = invalidTextPage.blocks.find(
      (block) => block.id === "second-block",
    );
    if (!invalidTextBlock) {
      throw new Error("Expected the second block.");
    }
    Reflect.set(invalidTextBlock, "translatedText", null);
    expect(() =>
      captureInpaintingLayoutStates(invalidTextPage, ["second-block"], {
        includeTranslatedText: true,
      }),
    ).toThrow(/번역문이 올바르지 않습니다/);
  });

  it("captures and restores render direction only when explicitly requested", () => {
    const page = makePage();
    const [directionState] = captureInpaintingLayoutStates(
      page,
      ["seed-block"],
      { includeRenderDirection: true },
    );
    if (!directionState) {
      throw new Error("Expected a captured direction state.");
    }
    expect(directionState).toMatchObject({ renderDirection: "horizontal" });

    const edited = {
      blocks: page.blocks.map((block) => ({
        ...block,
        renderDirection: "vertical" as const,
      })),
    };
    expect(pageMatchesInpaintingLayoutStates(edited, [directionState])).toBe(
      false,
    );
    expect(
      applyInpaintingLayoutStates(edited, [directionState]).blocks[0]
        ?.renderDirection,
    ).toBe("horizontal");

    const invalidDirectionState = structuredClone(directionState);
    Reflect.set(invalidDirectionState, "renderDirection", "diagonal");
    expect(() =>
      applyInpaintingLayoutStates(page, [invalidDirectionState]),
    ).toThrow(/텍스트 방향이 올바르지 않습니다/);
  });
});

function makePage(): Pick<MangaPage, "blocks"> {
  const block: TranslationBlock = {
    id: "seed-block",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 500, h: 400 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 16,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
  return { blocks: [block] };
}
