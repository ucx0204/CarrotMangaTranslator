import { describe, expect, it } from "vitest";
import { parseWorkContextModelJson } from "../src/main/workContextJsonParser";

describe("AI work context JSON parser", () => {
  it("parses fenced JSON with leading language labels", () => {
    expect(
      parseWorkContextModelJson(
        [
          "```json",
          "{",
          '  "glossary": [{"source": "魔王", "target": "마왕"}],',
          '  "characters": [],',
          '  "rules": {"honorifics": "adapt"},',
          '  "pageSummaries": []',
          "}",
          "```",
        ].join("\n"),
      ),
    ).toEqual(
      expect.objectContaining({
        glossary: [expect.objectContaining({ source: "魔王" })],
      }),
    );
  });

  it("extracts the first balanced JSON object from prose", () => {
    expect(
      parseWorkContextModelJson(
        '분석 결과입니다.\n{"glossary":[],"characters":[],"rules":{},"pageSummaries":[]}\n필요하면 더 분석할 수 있습니다.',
      ),
    ).toEqual({
      glossary: [],
      characters: [],
      rules: {},
      pageSummaries: [],
    });
  });

  it("repairs common loose JSON from compatible model endpoints", () => {
    expect(
      parseWorkContextModelJson(
        "{glossary:[{source:'魔王',target:'마왕',category:'character',}],characters:[],rules:{honorifics:'adapt',},pageSummaries:[],}",
      ),
    ).toEqual(
      expect.objectContaining({
        glossary: [
          expect.objectContaining({
            source: "魔王",
            target: "마왕",
            category: "character",
          }),
        ],
      }),
    );
  });
});
