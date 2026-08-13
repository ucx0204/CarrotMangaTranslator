import { describe, expect, it } from "vitest";
import type { WebImportCandidate } from "../src/shared/webImportTypes";
import {
  candidateMatchesWebImportFilter,
  filterWebImportCandidates,
  setVisibleWebImportSelection,
} from "../src/renderer/src/lib/webImportSelection";

describe("web import size and selection behavior", () => {
  it("uses the exact medium-or-larger and large pixel boundaries", () => {
    expect(candidateMatchesWebImportFilter({ pixelCount: 39_999 }, "all")).toBe(
      true,
    );
    expect(
      candidateMatchesWebImportFilter(
        { pixelCount: 39_999 },
        "medium-or-larger",
      ),
    ).toBe(false);
    expect(
      candidateMatchesWebImportFilter(
        { pixelCount: 40_000 },
        "medium-or-larger",
      ),
    ).toBe(true);
    expect(
      candidateMatchesWebImportFilter({ pixelCount: 479_999 }, "large"),
    ).toBe(false);
    expect(
      candidateMatchesWebImportFilter({ pixelCount: 480_000 }, "large"),
    ).toBe(true);
  });

  it("keeps manual exclusions while newly visible candidates remain selected", () => {
    const candidates = [
      candidate("small", 30_000),
      candidate("large", 600_000),
    ];
    const excluded = setVisibleWebImportSelection(
      new Set<string>(),
      ["large"],
      false,
    );
    expect(
      filterWebImportCandidates(candidates, "all").map((item) => item.id),
    ).toEqual(["small", "large"]);
    expect(excluded.has("large")).toBe(true);
    expect(excluded.has("small")).toBe(false);
  });
});

function candidate(id: string, pixelCount: number): WebImportCandidate {
  return {
    id,
    previewUrl: `mgt-import-preview://session/${id}`,
    width: pixelCount,
    height: 1,
    pixelCount,
    byteSize: 1,
    format: "png",
    storedExtension: ".png",
    pageIndex: 0,
  };
}
