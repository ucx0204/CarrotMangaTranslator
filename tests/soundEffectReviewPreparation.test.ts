import { describe, expect, it, vi } from "vitest";
import {
  createPrepareSoundEffectTranslationMutation,
  type PrepareSoundEffectTranslationRuntime,
} from "../src/main/libraryStore/librarySoundEffectMutations";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../src/shared/pageRevision";
import { resolveEffectiveSoundEffectReviewRegions } from "../src/shared/soundEffectReview";
import { createRestoreSoundEffectReviewMutation } from "../src/main/libraryStore/librarySoundEffectRestore";
import { RestoreSoundEffectReviewRequestSchema } from "../src/shared/ipcSoundEffectReviewSchemas";

describe("restore excluded sound-effect candidates", () => {
  it("persists restored decisions across reopening while retaining reviewed geometry and resolved candidates", async () => {
    const chapter = makeChapter();
    const first = chapter.pages[0];
    const review = requireReview(first);
    review.dismissedRegionIds = ["FX001", "FX002"];
    review.regionOverrides = [
      {
        regionId: "FX001",
        bbox: { x: 80, y: 90, w: 100, h: 110 },
        updatedAt: SAVE_TIME,
      },
    ];
    review.manualRegions = [
      {
        id: "manual-kept",
        bbox: { x: 400, y: 0, w: 50, h: 50 },
        detectorConfidence: 1,
        createdAt: SAVE_TIME,
      },
    ];
    review.resolvedRegions = [
      { regionId: "FX002", blockId: "translated", resolvedAt: SAVE_TIME },
    ];
    first.inpaintedImagePath = "C:/qa/kept.png";
    const storage = createStorageRuntime(chapter);
    const restore = createRestoreSoundEffectReviewMutation(storage.runtime);
    const request = {
      chapterId: chapter.id,
      pages: [
        {
          pageId: first.id,
          pageRevision: createSoundEffectReviewPageRevision(first),
          regionIds: ["FX001"],
        },
      ],
    };
    expect(
      RestoreSoundEffectReviewRequestSchema.safeParse(request).success,
    ).toBe(true);
    const result = await restore(request);
    expect(result.pages[0]?.soundEffectReview).toEqual({
      ...review,
      dismissedRegionIds: ["FX002"],
    });
    expect(storage.readStoredChapter().pages[0]).toEqual({
      ...first,
      soundEffectReview: result.pages[0]?.soundEffectReview,
      updatedAt: SAVE_TIME,
    });
    expect(storage.readStoredChapter().pages[1]).toEqual(chapter.pages[1]);
    expect(storage.commitChapterAndWork).toHaveBeenCalledOnce();
    await expect(restore(request)).rejects.toThrow(/변경되었습니다/);
    expect(storage.commitChapterAndWork).toHaveBeenCalledOnce();
  });

  it.each([
    "unknown",
    "resolved",
    "not-dismissed",
    "stale",
    "missing-page",
    "missing-review",
  ])("rejects %s targets without writing any page", async (kind) => {
    const chapter = makeChapter();
    chapter.pages.forEach((page) => {
      const review = requireReview(page);
      review.dismissedRegionIds = review.regions.map((region) => region.id);
    });
    const second = chapter.pages[1];
    if (kind === "resolved")
      requireReview(second).resolvedRegions = [
        { regionId: "FX003", blockId: "kept", resolvedAt: SAVE_TIME },
      ];
    if (kind === "not-dismissed") requireReview(second).dismissedRegionIds = [];
    if (kind === "missing-review") second.soundEffectReview = undefined;
    const storage = createStorageRuntime(chapter);
    const request = {
      chapterId: chapter.id,
      pages: chapter.pages.map((page) => ({
        pageId: page.id,
        pageRevision: createSoundEffectReviewPageRevision(page),
        regionIds: [page === second ? "FX003" : "FX001"],
      })),
    };
    if (kind === "unknown") request.pages[1].regionIds = ["unknown"];
    if (kind === "stale")
      request.pages[1].pageRevision = "page-v1:0000000000000000";
    if (kind === "missing-page") request.pages[1].pageId = "missing";
    await expect(
      createRestoreSoundEffectReviewMutation(storage.runtime)(request),
    ).rejects.toThrow();
    expect(storage.commitChapterAndWork).not.toHaveBeenCalled();
    expect(storage.readStoredChapter()).toEqual(chapter);
  });

  it("clears the last dismissal and propagates storage failures", async () => {
    const chapter = makeChapter();
    const page = chapter.pages[0];
    requireReview(page).dismissedRegionIds = ["FX001"];
    const storage = createStorageRuntime(chapter);
    const restore = createRestoreSoundEffectReviewMutation(storage.runtime);
    const request = {
      chapterId: chapter.id,
      pages: [
        {
          pageId: page.id,
          pageRevision: createSoundEffectReviewPageRevision(page),
          regionIds: ["FX001"],
        },
      ],
    };
    storage.commitChapterAndWork.mockRejectedValueOnce(new Error("disk full"));
    await expect(restore(request)).rejects.toThrow("disk full");
    expect(storage.readStoredChapter()).toEqual(chapter);
    expect(
      (await restore(request)).pages[0]?.soundEffectReview?.dismissedRegionIds,
    ).toBeUndefined();
  });

  it.each(["locator", "chapter"])(
    "reports a missing %s without committing",
    async (missing) => {
      const storage = createStorageRuntime(makeChapter());
      if (missing === "locator")
        storage.runtime.findChapterLocation.mockResolvedValueOnce(null);
      else storage.runtime.readChapterFile.mockResolvedValueOnce(null);
      await expect(
        createRestoreSoundEffectReviewMutation(storage.runtime)({
          chapterId: "missing",
          pages: [],
        }),
      ).rejects.toThrow(/화를 찾지/);
      expect(storage.commitChapterAndWork).not.toHaveBeenCalled();
    },
  );

  it("validates page and region identities at the IPC boundary", () => {
    const chapter = makeChapter();
    const page = {
      pageId: chapter.pages[0].id,
      pageRevision: createSoundEffectReviewPageRevision(chapter.pages[0]),
      regionIds: ["FX001"],
    };
    for (const pages of [
      [],
      [page, page],
      [{ ...page, regionIds: [] }],
      [{ ...page, regionIds: ["FX001", "FX001"] }],
      [{ ...page, pageRevision: "stale" }],
    ]) {
      expect(
        RestoreSoundEffectReviewRequestSchema.safeParse({
          chapterId: chapter.id,
          pages,
        }).success,
      ).toBe(false);
    }
  });
});

const SAVE_TIME = "2026-09-02T00:00:00.000Z";

function requireReview(page: LibraryChapter["pages"][number]) {
  if (!page.soundEffectReview) throw new Error("Expected review fixture");
  return page.soundEffectReview;
}

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
