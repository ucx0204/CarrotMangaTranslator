import { describe, expect, it } from "vitest";
import { isChapterMutationBlocked } from "../src/renderer/src/app/session/workspaceActivity";
import {
  pageContentResource,
  type AppActivityResource,
} from "../src/shared/appActivityTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

function model(resources: AppActivityResource[] | undefined) {
  const chapter: ChapterSnapshot = {
    id: "chapter-B",
    workId: "work",
    title: "B",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-B"],
    createdAt: "",
    updatedAt: "",
    pages: [
      {
        id: "page-B",
        name: "B",
        width: 600,
        height: 900,
        imagePath: "",
        dataUrl: "",
        blocks: [],
        analysisStatus: "idle",
        createdAt: "",
        updatedAt: "",
      },
    ],
  };
  return {
    core: { currentChapter: chapter },
    derivedState: {
      selectedPageEditLocked: false,
      activities: {
        version: 1,
        pages: [],
        activities: [
          {
            id: "active",
            category: "job" as const,
            kind: "gemma-analysis",
            mutatesLibrary: true,
            blocksQuit: true,
            startedAt: 1,
            resources,
          },
        ],
      },
    },
    workspaceHistory: { busy: false },
  };
}

describe("whole chapter edit ownership", () => {
  it("allows batch edits beside an unrelated model and page", () => {
    expect(
      isChapterMutationBlocked(
        model([
          { kind: "model-runtime", scope: "*", access: "write" },
          pageContentResource("chapter-A", "page-A"),
        ]),
      ),
    ).toBe(false);
  });
  it("rejects a conflicting page even when a different page is selected", () => {
    expect(
      isChapterMutationBlocked(
        model([pageContentResource("chapter-B", "page-B")]),
      ),
    ).toBe(true);
  });
  it("retains conservative undeclared-resource and history-restore guards", () => {
    expect(isChapterMutationBlocked(model(undefined))).toBe(true);
    const restoring = model([]);
    restoring.workspaceHistory.busy = true;
    expect(isChapterMutationBlocked(restoring)).toBe(true);
  });
});
