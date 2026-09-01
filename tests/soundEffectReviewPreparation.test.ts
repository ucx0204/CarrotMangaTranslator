import { describe, expect, it, vi } from "vitest";
import {
  createPrepareSoundEffectTranslationMutation,
  type PrepareSoundEffectTranslationRuntime,
} from "../src/main/libraryStore/librarySoundEffectMutations";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../src/shared/pageRevision";
import { resolveEffectiveSoundEffectReviewRegions } from "../src/shared/soundEffectReview";

const SAVE_TIME = "2026-09-02T00:00:00.000Z";

describe("sound-effect review preparation transaction", () => {
  it("stores two-page decisions atomically while preserving raw detector regions", async () => {
    const chapter = makeChapter();
    const storage = createStorageRuntime(chapter);
    const prepare = createPrepareSoundEffectTranslationMutation(
      storage.runtime,
    );
    const manualId = "manual-00000000-0000-4000-8000-000000000099";
    const result = await prepare({
      chapterId: chapter.id,
      pages: [
        {
          pageId: chapter.pages[0].id,
          pageRevision: createSoundEffectReviewPageRevision(chapter.pages[0]),
          includedRegionIds: ["FX001", manualId],
          editedRegions: [
            {
              regionId: "FX001",
              bbox: { x: 100, y: 110, w: 120, h: 130 },
            },
          ],
          addedRegions: [
            {
              regionId: manualId,
              bbox: { x: 400, y: 410, w: 90, h: 100 },
            },
          ],
          dismissedRegionIds: ["FX002"],
        },
        {
          pageId: chapter.pages[1].id,
          pageRevision: createSoundEffectReviewPageRevision(chapter.pages[1]),
          includedRegionIds: [],
          editedRegions: [],
          addedRegions: [],
          dismissedRegionIds: ["FX003"],
        },
      ],
    });

    expect(storage.commitChapterAndWork).toHaveBeenCalledOnce();
    expect(result.includedRegionCount).toBe(2);
    expect(result.dismissedRegionCount).toBe(2);
    expect(result.targets).toEqual([
      expect.objectContaining({
        pageId: chapter.pages[0].id,
        regionIds: ["FX001", manualId],
      }),
    ]);
    const stored = storage.readStoredChapter();
    const firstReview = stored.pages[0].soundEffectReview;
    if (!firstReview) throw new Error("Expected stored SFX review.");
    expect(firstReview.regions[0]).toMatchObject({
      id: "FX001",
      recognizedText: "ドン",
      bbox: { x: 10, y: 20, w: 100, h: 120 },
    });
    expect(firstReview.regionOverrides).toEqual([
      expect.objectContaining({
        regionId: "FX001",
        bbox: { x: 100, y: 110, w: 120, h: 130 },
      }),
    ]);
    expect(firstReview.manualRegions).toEqual([
      expect.objectContaining({
        id: manualId,
        bbox: { x: 400, y: 410, w: 90, h: 100 },
      }),
    ]);
    expect(firstReview.dismissedRegionIds).toEqual(["FX002"]);
    expect(resolveEffectiveSoundEffectReviewRegions(firstReview)).toEqual([
      expect.objectContaining({
        id: "FX001",
        bbox: { x: 100, y: 110, w: 120, h: 130 },
      }),
      expect.objectContaining({ id: "FX002" }),
      expect.objectContaining({ id: manualId }),
    ]);
    expect(
      resolveEffectiveSoundEffectReviewRegions(firstReview)[0],
    ).not.toHaveProperty("recognizedText");
  });

  it("rejects a stale page before publishing any page in the draft", async () => {
    const chapter = makeChapter();
    const storage = createStorageRuntime(chapter);
    const prepare = createPrepareSoundEffectTranslationMutation(
      storage.runtime,
    );
    await expect(
      prepare({
        chapterId: chapter.id,
        pages: [
          {
            pageId: chapter.pages[0].id,
            pageRevision: createSoundEffectReviewPageRevision(chapter.pages[0]),
            includedRegionIds: ["FX001"],
            editedRegions: [],
            addedRegions: [],
            dismissedRegionIds: ["FX002"],
          },
          {
            pageId: chapter.pages[1].id,
            pageRevision: "page-v1:0000000000000000",
            includedRegionIds: ["FX003"],
            editedRegions: [],
            addedRegions: [],
            dismissedRegionIds: [],
          },
        ],
      }),
    ).rejects.toThrow(/변경되었습니다/);
    expect(storage.commitChapterAndWork).not.toHaveBeenCalled();
    expect(storage.readStoredChapter()).toEqual(chapter);
  });

  it("rejects out-of-page edits before opening a transaction", async () => {
    const chapter = makeChapter();
    const storage = createStorageRuntime(chapter);
    const prepare = createPrepareSoundEffectTranslationMutation(
      storage.runtime,
    );
    await expect(
      prepare({
        chapterId: chapter.id,
        pages: [
          {
            pageId: chapter.pages[0].id,
            pageRevision: createSoundEffectReviewPageRevision(chapter.pages[0]),
            includedRegionIds: ["FX001"],
            editedRegions: [
              {
                regionId: "FX001",
                bbox: { x: 990, y: 20, w: 20, h: 120 },
              },
            ],
            addedRegions: [],
            dismissedRegionIds: ["FX002"],
          },
        ],
      }),
    ).rejects.toThrow(/페이지 범위/);
    expect(storage.commitChapterAndWork).not.toHaveBeenCalled();
  });
});

function createStorageRuntime(initialChapter: LibraryChapter) {
  let storedChapter = initialChapter;
  const findChapterLocation = vi.fn<
    PrepareSoundEffectTranslationRuntime["findChapterLocation"]
  >(async () => ({
    workId: initialChapter.workId,
    chapterId: initialChapter.id,
  }));
  const readChapterFile = vi.fn<
    PrepareSoundEffectTranslationRuntime["readChapterFile"]
  >(async () => storedChapter);
  const commitChapterAndWork = vi.fn<
    PrepareSoundEffectTranslationRuntime["commitChapterAndWork"]
  >(async (chapter) => {
    storedChapter = chapter;
  });
  return {
    runtime: {
      findChapterLocation,
      readChapterFile,
      commitChapterAndWork,
      now: () => SAVE_TIME,
    },
    commitChapterAndWork,
    readStoredChapter: () => storedChapter,
  };
}

function makeChapter(): LibraryChapter {
  const timestamp = "2026-09-01T00:00:00.000Z";
  const pages: LibraryChapter["pages"] = [
    makePage("00000000-0000-4000-8000-000000000011", "001.png", [
      {
        id: "FX001",
        bbox: { x: 10, y: 20, w: 100, h: 120 },
        detectorConfidence: 0.9,
        recognizedText: "ドン",
      },
      {
        id: "FX002",
        bbox: { x: 250, y: 20, w: 100, h: 120 },
        detectorConfidence: 0.8,
      },
    ]),
    makePage("00000000-0000-4000-8000-000000000012", "002.png", [
      {
        id: "FX003",
        bbox: { x: 40, y: 50, w: 100, h: 120 },
        detectorConfidence: 0.85,
      },
    ]),
  ];
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workId: "00000000-0000-4000-8000-000000000002",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makePage(
  id: string,
  name: string,
  regions: NonNullable<
    LibraryChapter["pages"][number]["soundEffectReview"]
  >["regions"],
): LibraryChapter["pages"][number] {
  const timestamp = "2026-09-01T00:00:00.000Z";
  return {
    id,
    name,
    imagePath: `C:/qa/${name}`,
    width: 1000,
    height: 1400,
    blocks: [],
    soundEffectReview: {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regions,
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [],
    },
    analysisStatus: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
