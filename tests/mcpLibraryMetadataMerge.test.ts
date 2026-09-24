import { expect, it } from "vitest";
import {
  mergeLiveChapterPreservingDirtyPages,
  resolveSelectionAfterChapterSync,
} from "../src/renderer/src/lib/chapterSync";
import { editingChapter } from "./mcpEditing.fixture";

it("adopts explicitly refreshed Undo metadata even when its restored timestamp is older, without dropping unsaved dialogue", () => {
  const live = editingChapter();
  live.title = "Restored original title";
  live.updatedAt = "2026-09-20T10:00:00.000Z";
  const local = structuredClone(live);
  local.title = "Name before Undo";
  local.updatedAt = "2026-09-20T11:00:00.000Z";
  local.pages[0].blocks[0].translatedText = "Unsaved user dialogue";
  const before = structuredClone(local);
  const merged = mergeLiveChapterPreservingDirtyPages(live, local, ["page"], {
    preferLiveMetadata: true,
  });
  expect(merged.chapter.title).toBe(live.title);
  expect(merged.chapter.updatedAt).toBe(live.updatedAt);
  expect(merged.chapter.pages[0].blocks).toEqual(local.pages[0].blocks);
  expect(merged.preservedDirtyPageIds).toEqual(["page"]);
  expect(local).toEqual(before);
});

it("retains the ordinary newer-metadata rule unless an explicit metadata refresh requested restoration", () => {
  const old = editingChapter();
  old.updatedAt = "2026-09-20T10:00:00.000Z";
  const current = structuredClone(old);
  current.title = "Newer ordinary state";
  current.updatedAt = "2026-09-20T11:00:00.000Z";
  expect(
    mergeLiveChapterPreservingDirtyPages(old, current, []).chapter.title,
  ).toBe(current.title);
  expect(
    mergeLiveChapterPreservingDirtyPages(old, null, [], {
      preferLiveMetadata: true,
    }).chapter,
  ).toBe(old);
});

it("adopts restored page order while retaining selected dirty page and block content", () => {
  const live = editingChapter();
  live.pages.push({ ...structuredClone(live.pages[0]), id: "second" });
  live.pageOrder.push("second");
  live.updatedAt = "2026-09-20T10:00:00.000Z";
  const local = structuredClone(live);
  local.pageOrder.reverse();
  local.pages.reverse();
  local.updatedAt = "2026-09-20T11:00:00.000Z";
  local.pages[0].blocks[0].translatedText = "Unsaved second-page dialogue";
  const result = mergeLiveChapterPreservingDirtyPages(live, local, ["second"], {
    preferLiveMetadata: true,
  });
  expect(result.chapter.pageOrder).toEqual(live.pageOrder);
  expect(result.chapter.pages.map((page) => page.id)).toEqual(live.pageOrder);
  expect(result.chapter.pages[1].blocks[0].translatedText).toBe(
    "Unsaved second-page dialogue",
  );
  expect(result.preservedDirtyPageIds).toEqual(["second"]);
  expect(
    resolveSelectionAfterChapterSync(result.chapter, "second", "a"),
  ).toEqual({ selectedPageId: "second", selectedBlockId: "a" });
});
