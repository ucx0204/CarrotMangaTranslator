import { describe, expect, it } from "vitest";

const fixed =
  require("../src/main/runtime/semantic-ocr/fixed-block-translation.cjs") as {
    buildFixedBlockTranslationPrompt: (
      plan: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => string;
    buildFixedBlockTranslationSystemPrompt: (
      options: Record<string, unknown>,
    ) => string;
  };

const plan = {
  version: 6,
  blocks: [
    {
      blockId: "B001",
      jp: "ありがとう",
      direction: "vertical",
      bbox: { x1: 10, y1: 20, x2: 80, y2: 180 },
    },
  ],
};
const options = { sourceLanguage: "ja", targetLanguage: "ko" };

describe("fixed-block prompt envelope", () => {
  it("names items as the only translation envelope", () => {
    const prompt = fixed.buildFixedBlockTranslationPrompt(plan, options);

    expect(prompt).toContain('exactly {"items":[...]}');
    expect(prompt).toContain('never "blocks", "translations", "results"');
    expect(fixed.buildFixedBlockTranslationSystemPrompt(options)).toContain(
      'shaped {"items":[...]}',
    );
  });

  it("permits pageContext without renaming items", () => {
    const prompt = fixed.buildFixedBlockTranslationPrompt(plan, {
      ...options,
      collectPageContext: true,
    });

    expect(prompt).toContain(
      'only "items" and "pageContext" are permitted at the top level',
    );
  });
});
