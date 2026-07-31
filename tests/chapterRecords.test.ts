import { describe, expect, it } from "vitest";
import { resolveChapterStatus } from "../src/main/libraryStore/chapterRecords";
import type { MangaPage } from "../src/shared/libraryTypes";

function statuses(...values: MangaPage["analysisStatus"][]) {
  return values.map((analysisStatus) => ({ analysisStatus }));
}

describe("chapter analysis status", () => {
  it("keeps failed plus unattempted pages partial instead of idle", () => {
    expect(resolveChapterStatus(statuses("failed", "idle"))).toBe("partial");
  });

  it("preserves terminal and mixed status distinctions", () => {
    expect(resolveChapterStatus(statuses("failed", "failed"))).toBe("failed");
    expect(resolveChapterStatus(statuses("completed", "completed"))).toBe(
      "completed",
    );
    expect(resolveChapterStatus(statuses("completed", "failed"))).toBe(
      "partial",
    );
    expect(resolveChapterStatus(statuses("idle", "idle"))).toBe("idle");
    expect(resolveChapterStatus(statuses("failed", "running"))).toBe("running");
  });

  it("does not mark a combined translation complete before its required downstream stage", () => {
    expect(
      resolveChapterStatus([
        {
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "bubble-layout",
            status: "pending",
          },
        },
      ]),
    ).toBe("partial");
    expect(
      resolveChapterStatus([
        {
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "bubble-layout",
            status: "failed",
          },
        },
      ]),
    ).toBe("failed");
    expect(
      resolveChapterStatus([
        {
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "bubble-layout",
            status: "completed",
          },
        },
      ]),
    ).toBe("completed");
  });
});
