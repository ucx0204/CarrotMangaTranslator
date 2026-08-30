import { describe, expect, it } from "vitest";
import {
  createUpdatePageProcessingTimingsMutation,
  type PageProcessingTimingMutationRuntime,
} from "../src/main/libraryStore/libraryTimingMutations";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import type { PageProcessingTimingV2 } from "../src/shared/pageProcessingTiming";

const SESSION_A = "00000000-0000-4000-8000-000000000001";
const SESSION_B = "00000000-0000-4000-8000-000000000002";
describe("page timing library persistence", () => {
  it("updates only timing and rejects a late checkpoint from an older session", async () => {
    let storedChapter = createChapter();
    const originalPage = structuredClone(storedChapter.pages[0]);
    const updateTimings = createUpdatePageProcessingTimingsMutation({
      findChapterLocation: async (chapterId) =>
        chapterId === storedChapter.id
          ? { workId: storedChapter.workId, chapterId }
          : null,
      now: () => "2026-08-30T00:00:01.000Z",
      readChapterFile: async (workId, chapterId) =>
        workId === storedChapter.workId && chapterId === storedChapter.id
          ? structuredClone(storedChapter)
          : null,
      commitChapterAndWork: async (chapter) => {
        storedChapter = structuredClone(chapter);
        return true;
      },
    } satisfies PageProcessingTimingMutationRuntime);
    const firstTiming = timing(SESSION_A, 1, 1_250);

    const firstChanged = await updateTimings("chapter-a", [
      { pageId: "page-a", timing: firstTiming, startSession: true },
    ]);
    expect([...firstChanged]).toEqual(["page-a"]);
    expect(storedChapter.pages[0]).toMatchObject({
      blocks: originalPage?.blocks,
      analysisStatus: originalPage?.analysisStatus,
      updatedAt: originalPage?.updatedAt,
      processingTiming: firstTiming,
    });

    const secondTiming = timing(SESSION_B, 1, 2_500);
    const secondChanged = await updateTimings("chapter-a", [
      {
        pageId: "page-a",
        timing: secondTiming,
        startSession: true,
        replacesSessionId: SESSION_A,
      },
    ]);
    expect([...secondChanged]).toEqual(["page-a"]);

    const staleChanged = await updateTimings("chapter-a", [
      { pageId: "page-a", timing: timing(SESSION_A, 99, 99_000) },
    ]);
    expect([...staleChanged]).toEqual([]);
    expect(storedChapter.pages[0]?.processingTiming).toEqual(secondTiming);
  });
});

function createChapter(): LibraryChapter {
  return {
    id: "chapter-a",
    workId: "work-1",
    title: "1화",
    sourceKind: "folder",
    status: "running",
    pageOrder: ["page-a"],
    pages: [
      {
        id: "page-a",
        name: "001.png",
        imagePath: "C:\\library\\works\\work-1\\chapter-a\\001.png",
        width: 100,
        height: 120,
        blocks: [
          {
            id: "block-1",
            type: "nonsolid",
            bbox: { x: 10, y: 10, w: 80, h: 80 },
            sourceText: "編集中",
            translatedText: "사용자 편집",
            confidence: 0.95,
            sourceDirection: "vertical",
            renderDirection: "horizontal",
            fontSizePx: 18,
            lineHeight: 1.2,
            textAlign: "center",
            textColor: "#111111",
            backgroundColor: "#ffffff",
            opacity: 0.8,
          },
        ],
        analysisStatus: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function timing(
  sessionId: string,
  checkpoint: number,
  preparing: number,
): PageProcessingTimingV2 {
  return {
    version: 2,
    sessionId,
    state: "running",
    checkpoint,
    measuredAt: "2026-08-30T00:00:00.000Z",
    stages: { preparing },
  };
}
