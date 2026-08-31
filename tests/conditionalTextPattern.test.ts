import { describe, expect, it } from "vitest";
import { parseConditionalBatchSnapshot } from "../src/shared/conditionalBatchRules";
import {
  compileConditionalTextMatcher,
  createConditionalLiteralMatcher,
  createConditionalLiteralReplacement,
  createConditionalPatternRepeat,
  findConditionalTextMatches,
  tryConvertConditionalRegexToVisual,
  type ConditionalPatternNodeV3,
  type ConditionalTextMatcherV3,
} from "../src/shared/conditionalTextPattern";

describe("conditional text pattern v3", () => {
  it("treats regex punctuation as ordinary text in visual literals", () => {
    const needle = [".", "$", "[", "\\"].join("");
    const text = `앞 ${needle} 뒤 ${needle}`;
    const ranges = findConditionalTextMatches(
      text,
      createConditionalLiteralMatcher(needle),
      createConditionalLiteralReplacement("교체"),
      true,
    );
    expect(ranges.map((range) => [range.text, range.replacement])).toEqual([
      [needle, "교체"],
      [needle, "교체"],
    ]);
  });

  it("matches Unicode numbers and letters without requiring regex syntax", () => {
    const matcher = visual([
      character("number", { min: 1, max: null, greedy: true }),
      literal("-"),
      character("letter", { min: 1, max: null, greedy: true }),
    ]);
    expect(
      findConditionalTextMatches("１２-화 42-話", matcher, null, true).map(
        (range) => range.text,
      ),
    ).toEqual(["１２-화", "42-話"]);
  });

  it("inserts remembered visual parts after nodes are reordered", () => {
    const number = {
      ...character("number", { min: 1, max: null, greedy: true }),
      captureId: "chapter-number",
    } satisfies ConditionalPatternNodeV3;
    const matcher = visual([literal("제"), number, literal("화")]);
    const ranges = findConditionalTextMatches(
      "제12화와 제３화",
      matcher,
      {
        mode: "visual",
        parts: [
          { id: "r1", kind: "capture", captureId: "chapter-number" },
          { id: "r2", kind: "literal", text: "화" },
        ],
      },
      true,
    );
    expect(ranges.map((range) => range.replacement)).toEqual(["12화", "３화"]);

    const reordered = visual([number, literal("화")]);
    expect(
      findConditionalTextMatches(
        "12화",
        reordered,
        {
          mode: "visual",
          parts: [{ id: "r1", kind: "capture", captureId: "chapter-number" }],
        },
        true,
      )[0]?.replacement,
    ).toBe("12");
  });

  it("supports choices, groups, boundaries, exact counts, and ranges", () => {
    const matcher = visual([
      { id: "start", kind: "boundary", boundary: "start" },
      {
        id: "group",
        kind: "group",
        nodes: [
          {
            id: "choice",
            kind: "choice",
            options: ["!", "！"],
            repeat: createConditionalPatternRepeat(),
          },
          literal(" "),
        ],
        repeat: createConditionalPatternRepeat({ min: 2, max: 3 }),
      },
      { id: "end", kind: "boundary", boundary: "end" },
    ]);
    expect(
      findConditionalTextMatches("! ！ ", matcher, null, true),
    ).toHaveLength(1);
    expect(
      findConditionalTextMatches("앞 ! ！ ", matcher, null, true),
    ).toHaveLength(0);
  });

  it("uses shortest matching for the default any-character repetition", () => {
    const matcher = visual([
      literal("「"),
      character("any", { min: 1, max: null, greedy: false }),
      literal("」"),
    ]);
    expect(
      findConditionalTextMatches("「하나」와 「둘」", matcher, null, true).map(
        (range) => range.text,
      ),
    ).toEqual(["「하나」", "「둘」"]);
  });

  it("supports first-only, all, and deletion replacements", () => {
    const matcher = createConditionalLiteralMatcher("  ");
    expect(
      findConditionalTextMatches(
        "a  b  c",
        matcher,
        createConditionalLiteralReplacement(" "),
        false,
      ),
    ).toHaveLength(1);
    expect(
      findConditionalTextMatches(
        "a  b  c",
        matcher,
        { mode: "visual", parts: [] },
        true,
      ).map((range) => range.replacement),
    ).toEqual(["", ""]);
  });

  it("keeps arbitrary regex and numbered replacements as an advanced pattern", () => {
    const parsed = parseConditionalBatchSnapshot({
      schemaVersion: 1,
      schemes: [
        {
          id: "legacy-regex",
          name: "예전 정규식",
          description: "",
          match: { mode: "allBlocks", conditions: [], groups: [] },
          actions: [
            {
              id: "replace",
              enabled: true,
              type: "replaceText",
              target: "translatedText",
              matcher: {
                mode: "regex",
                source: "(제)(\\d+)(화)",
                caseSensitive: false,
              },
              replacement: { mode: "raw", source: "$2회" },
              allOccurrences: true,
            },
          ],
        },
      ],
      sequences: [],
    });
    expect(parsed.snapshot.schemaVersion).toBe(1);
    expect(parsed.snapshot.schemes[0]?.actions[0]).toMatchObject({
      matcher: {
        mode: "regex",
        source: "(제)(\\d+)(화)",
        caseSensitive: false,
      },
      replacement: { mode: "raw", source: "$2회" },
    });
  });

  it("groups a multi-character literal before applying repetition", () => {
    const matcher = visual([
      {
        ...literal("ab"),
        repeat: createConditionalPatternRepeat({ min: 2, max: 2 }),
      },
    ]);
    expect(compileConditionalTextMatcher(matcher).source).toContain(
      "(?:ab){2}",
    );
    expect(
      findConditionalTextMatches("abab", matcher, null, true),
    ).toHaveLength(1);
  });

  it("returns supported raw patterns to the visual builder and leaves arbitrary regex advanced", () => {
    const converted = tryConvertConditionalRegexToVisual(
      {
        mode: "regex",
        source: "제\\p{N}+화",
        caseSensitive: true,
      },
      { mode: "raw", source: "회" },
    );
    expect(converted?.matcher).toMatchObject({
      mode: "visual",
      nodes: [
        { kind: "literal", text: "제" },
        {
          kind: "character",
          character: "number",
          repeat: { min: 1, max: null },
        },
        { kind: "literal", text: "화" },
      ],
    });
    expect(converted?.replacement).toMatchObject({
      mode: "visual",
      parts: [{ kind: "literal", text: "회" }],
    });
    expect(
      tryConvertConditionalRegexToVisual(
        { mode: "regex", source: "(제)(\\d+)", caseSensitive: true },
        { mode: "raw", source: "$2" },
      ),
    ).toBeNull();
  });
});

function visual(nodes: ConditionalPatternNodeV3[]): ConditionalTextMatcherV3 {
  return { mode: "visual", caseSensitive: true, nodes };
}

function literal(
  text: string,
): Extract<ConditionalPatternNodeV3, { kind: "literal" }> {
  return {
    id: `literal-${text}`,
    kind: "literal",
    text,
    repeat: createConditionalPatternRepeat(),
  };
}

function character(
  value: Extract<ConditionalPatternNodeV3, { kind: "character" }>["character"],
  repeat = createConditionalPatternRepeat(),
): Extract<ConditionalPatternNodeV3, { kind: "character" }> {
  return {
    id: `character-${value}-${repeat.min}-${repeat.max}`,
    kind: "character",
    character: value,
    repeat,
  };
}
