import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { workFileFixture } from "./mcpWorkFileImport.fixture";
import { workFileAppendFixture } from "./mcpWorkFileAppend.fixture";

it("imports 500 editable work-file pages as one chapter and replays after restart", async () => {
  const f = await workFileFixture(500, true);
  try {
    const { command, view } = await f.prepareWorkFile();
    expect(view.pageCount).toBe(500);
    const receipt = await f.createWorkFile(command);
    expect(receipt.pageCount).toBe(500);
    expect(receipt.chapterIds).toHaveLength(1);
    const chapter = await f.library.openChapter(receipt.chapterIds[0]);
    expect(chapter.pages).toHaveLength(500);
    for (const i of [0, 249, 499])
      expect(await readFile(chapter.pages[i].imagePath)).toEqual(
        await readFile(f.originalChapter.pages[i].imagePath),
      );
    await f.restart();
    expect(await f.createWorkFile(command)).toEqual(receipt);
  } finally {
    await f.close();
  }
}, 120_000);

it("appends 500 work-file pages while preserving destination chapters and context", async () => {
  const f = await workFileAppendFixture(500, true);
  try {
    const before = await f.capture();
    const { command } = await f.prepareAppend();
    const receipt = await f.createWorkFile(command);
    expect(receipt.workId).toBe("work");
    expect(receipt.pageCount).toBe(500);
    expect(receipt.chapterIds).toHaveLength(1);
    const after = await f.capture();
    expect(after.chapter).toEqual(before.chapter);
    expect(after.guide).toEqual(before.guide);
    expect(
      (await f.library.openChapter(receipt.chapterIds[0])).pages,
    ).toHaveLength(500);
    await f.restart();
    expect(await f.createWorkFile(command)).toEqual(receipt);
  } finally {
    await f.close();
  }
}, 120_000);
