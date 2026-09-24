import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";

it("preserves imported source history through native naming, ordering and processing-state saves", async () => {
  const f = await importDuplicateFixture();
  try {
    const receipt = await f.create(await f.command(await f.prepare()));
    const before = await f.library.openChapter(receipt.chapterIds[0]);
    const originals = await Promise.all(
      f.originals.map((path) => readFile(path)),
    );
    const savedBytes = await Promise.all(
      before.pages.map((page) => readFile(page.imagePath)),
    );
    const expectedOrder = [...before.pageOrder].reverse();
    await f.library.renameWork(receipt.workId, "Renamed native work");
    await f.library.renameChapter(before.id, "Renamed native chapter");
    await f.library.reorderPages(before.id, expectedOrder);
    await f.library.markChapterPagesRunning(before.id, [before.pages[0].id]);
    await f.library.finalizeRunningPages(
      before.id,
      [before.pages[0].id],
      "idle",
    );
    const after = await f.library.openChapter(before.id);
    expect(after.title).toBe("Renamed native chapter");
    expect(after.pageOrder).toEqual(expectedOrder);
    expect(after.importSource).toEqual(before.importSource);
    expect(
      await Promise.all(before.pages.map((page) => readFile(page.imagePath))),
    ).toEqual(savedBytes);
    expect(
      await Promise.all(f.originals.map((path) => readFile(path))),
    ).toEqual(originals);
    const fresh = await f.command(await f.prepare());
    fresh.target = await f.target(receipt.workId);
    expect(await f.review(fresh)).toMatchObject({
      historicalOnly: true,
      historyChapterCount: 1,
      untrackedChapterCount: 0,
      chapters: [
        {
          status: "known-content",
          matches: [{ chapterId: before.id, match: "content" }],
        },
      ],
    });
    expect(f.web.scan).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("keeps input history distinct from current page availability and never mutates original input files", async () => {
  const f = await importDuplicateFixture();
  try {
    const receipt = await f.create(await f.command(await f.prepare()));
    const before = await f.library.openChapter(receipt.chapterIds[0]);
    const sourceBytes = await Promise.all(
      f.originals.map((path) => readFile(path)),
    );
    const remaining = await f.library.deletePage(before.id, before.pages[1].id);
    expect(remaining.pages).toHaveLength(1);
    expect(remaining.importSource).toEqual(before.importSource);
    expect(remaining.importSource?.pageCount).toBe(2);
    await f.restart();
    const fresh = await f.command(await f.prepare());
    fresh.target = await f.target(receipt.workId);
    expect(await f.review(fresh)).toMatchObject({
      historicalOnly: true,
      historyChapterCount: 1,
      chapters: [{ status: "known-content" }],
    });
    await f.library.deleteChapter(before.id);
    fresh.target = await f.target(receipt.workId);
    expect(await f.review(fresh)).toMatchObject({
      historicalOnly: true,
      historyChapterCount: 0,
      untrackedChapterCount: 0,
      chapters: [{ status: "unseen", matchingChapterCount: 0 }],
    });
    expect(
      await Promise.all(f.originals.map((path) => readFile(path))),
    ).toEqual(sourceBytes);
    expect(f.web.scan).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
