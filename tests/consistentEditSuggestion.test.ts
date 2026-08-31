import { describe, expect, it } from "vitest";
import { deriveSingleTextReplacement } from "../src/renderer/src/lib/consistentEditSuggestion";

describe("consistent edit suggestion", () => {
  it("extracts one continuous replacement from the visible translation", () => {
    expect(deriveSingleTextReplacement("카렌이 왔다", "카랜이 왔다")).toEqual({
      find: "렌",
      replace: "랜",
    });
    expect(deriveSingleTextReplacement("정말 정말", "정말")).toEqual({
      find: " 정말",
      replace: "",
    });
  });

  it("ignores markup-only, insertion-only, multiline and likely disjoint edits", () => {
    expect(deriveSingleTextReplacement("카렌", "**카렌**")).toBeNull();
    expect(deriveSingleTextReplacement("카렌", "카렌 님")).toBeNull();
    expect(deriveSingleTextReplacement("한 줄", "한\n줄")).toBeNull();
    expect(
      deriveSingleTextReplacement("abcAdefBghi", "abcXdefYghi"),
    ).toBeNull();
  });

  it("keeps unicode characters intact", () => {
    expect(deriveSingleTextReplacement("🍎이다", "🍏이다")).toEqual({
      find: "🍎",
      replace: "🍏",
    });
  });
});
