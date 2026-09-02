import { describe, expect, it, vi } from "vitest";
import {
  createConditionalBatchSequenceItemId,
  moveConditionalBatchSequenceItem,
} from "../src/renderer/src/components/conditionalBatchSequenceModel";

describe("conditional batch sequence model", () => {
  it("moves an item without mutating the source order", () => {
    const source = ["first", "second", "third"] as const;

    expect(moveConditionalBatchSequenceItem(source, 0, 2)).toEqual([
      "second",
      "third",
      "first",
    ]);
    expect(source).toEqual(["first", "second", "third"]);
  });

  it.each([
    [-1, 0],
    [0, -1],
    [3, 0],
    [0, 3],
  ])("returns an unchanged copy for invalid bounds %s → %s", (from, to) => {
    const source = ["first", "second", "third"];
    const result = moveConditionalBatchSequenceItem(source, from, to);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });

  it("creates an opaque id with the requested ownership prefix", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);

    expect(createConditionalBatchSequenceItemId("step")).toMatch(
      /^step:[a-z0-9]+:[a-z0-9]{6}$/u,
    );

    vi.restoreAllMocks();
  });
});
