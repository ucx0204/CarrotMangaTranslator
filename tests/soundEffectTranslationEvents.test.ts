import { expect, it, vi } from "vitest";
import { finishSoundEffectTranslation } from "../src/main/jobs/soundEffectTranslationEvents";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

it.each([
  [0, "failed"],
  [1, "partial"],
  [3, "completed"],
] as const)(
  "reports %i successful regions as %s and preserves diagnostics",
  (count, status) => {
    const chapter: ChapterSnapshot = {
      id: "chapter",
      workId: "work",
      title: "chapter",
      status: "idle",
      sourceKind: "images",
      pageOrder: [],
      createdAt: "2026-09-11T00:00:00Z",
      updatedAt: "2026-09-11T00:00:00Z",
      pages: [],
    };
    const warnings = ["FX001: response validation failed"];
    const state = {
      chapter,
      translatedRegionCount: count,
      createdBlocksByPage: [],
      warnings,
    };
    const emit = vi.fn();
    const result = finishSoundEffectTranslation(
      { id: "job", emit, state },
      chapter,
      3,
      1,
    );
    expect(result).toMatchObject({
      status,
      translatedRegionCount: count,
      warnings,
    });
    expect(result.chapter).toBe(chapter);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ status }));
    if (status === "failed") {
      expect(result.error).toContain("후보는 그대로 보존");
      expect(emit.mock.calls[0][0].detail).toBe(result.error);
    } else {
      expect(result.error).toBeUndefined();
    }
    expect(state.translatedRegionCount).toBe(count);
  },
);
