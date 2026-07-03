import { describe, expect, it } from "vitest";
import {
  buildMatchOffsets,
  countMatches,
  matchOffsetKey,
  splitHighlightSegments,
  visibleLines,
} from "../src/renderer/src/lib/gatherTextSearch";
import type { GatheredPage } from "../src/renderer/src/lib/gatherText";

const pages: GatheredPage[] = [
  {
    pageId: "p1",
    pageName: "a.png",
    index: 0,
    blocks: [
      { id: "b1", sourceText: "aa", translatedText: "a" },
      { id: "b2", sourceText: "", translatedText: "banana" },
    ],
  },
  {
    pageId: "p2",
    pageName: "b.png",
    index: 1,
    blocks: [{ id: "b3", sourceText: "cat", translatedText: "dog" }],
  },
];

describe("splitHighlightSegments", () => {
  it("splits matches case-insensitively", () => {
    const segments = splitHighlightSegments("banana", "A");
    expect(segments.filter((segment) => segment.match).length).toBe(3);
    expect(segments.map((segment) => segment.text).join("")).toBe("banana");
  });

  it("returns a single non-match segment for an empty query", () => {
    expect(splitHighlightSegments("hello", "")).toEqual([
      { text: "hello", match: false },
    ]);
  });
});

describe("visibleLines", () => {
  it("lists OCR then translation per block, skipping empties, in page order", () => {
    expect(visibleLines(pages, "both").map((line) => line.text)).toEqual([
      "aa",
      "a",
      "banana",
      "cat",
      "dog",
    ]);
  });
});

describe("countMatches / buildMatchOffsets", () => {
  it("offsets are cumulative and align with the total count", () => {
    expect(countMatches(pages, "both", "a")).toBe(7);

    const offsets = buildMatchOffsets(pages, "both", "a");
    expect(offsets.get(matchOffsetKey("b1", "source"))).toBe(0);
    expect(offsets.get(matchOffsetKey("b1", "translated"))).toBe(2);
    expect(offsets.get(matchOffsetKey("b2", "translated"))).toBe(3);
    expect(offsets.get(matchOffsetKey("b3", "source"))).toBe(6);
    expect(offsets.get(matchOffsetKey("b3", "translated"))).toBe(7);
  });

  it("is empty for a blank query", () => {
    expect(countMatches(pages, "both", "")).toBe(0);
    expect(buildMatchOffsets(pages, "both", "").size).toBe(0);
  });
});
