import { describe, expect, it } from "vitest";
import {
  selectPriorityTextItemIndexes,
  spreadItemIndexes,
} from "../src/main/workContextResearchTextSelection";

describe("work-context research text selection", () => {
  it("keeps up to two normalized contexts for each saved term", () => {
    expect(
      selectPriorityTextItemIndexes(
        ["ロッド！ first", "unrelated", "ロッド second", "ロッド third"],
        [" ロッド ", "missing"],
      ),
    ).toEqual([0, 2]);
  });

  it("spreads bounded samples across the complete page range", () => {
    expect(spreadItemIndexes(0)).toEqual([]);
    expect(spreadItemIndexes(2)).toEqual([0, 1]);
    expect(spreadItemIndexes(5)).toEqual([0, 4, 2, 1, 3]);
  });
});
