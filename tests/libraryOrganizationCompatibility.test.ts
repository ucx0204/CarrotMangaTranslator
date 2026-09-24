import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";

it("preserves native title normalization, unique chapter names and partial reorder behavior", async () => {
  const f = await importDuplicateFixture();
  try {
    const first = await f.create(await f.command(await f.prepare()));
    const append = await f.command(await f.prepare());
    append.target = await f.target(first.workId);
    const second = await f.create(append);
    const a = await f.library.openChapter(first.chapterIds[0]);
    const b = await f.library.openChapter(second.chapterIds[0]);
    const images = await Promise.all(
      a.pages.map((page) => readFile(page.imagePath)),
    );
    await f.library.renameWork(first.workId, "  이름 日本語 <script> 😀  ");
    await f.library.renameChapter(b.id, `  ${a.title}  `);
    await f.library.reorderChapters(first.workId, [b.id]);
    const work = (await f.library.listLibrary()).works.find(
      (item) => item.id === first.workId,
    );
    expect(work?.title).toBe("이름 日本語 <script> 😀");
    expect(work?.chapters.map((item) => item.id)).toEqual([b.id, a.id]);
    const after = await f.library.openChapter(b.id);
    expect(after.title).toBe(`${a.title} (1)`);
    expect(after.pages).toEqual(b.pages);
    expect(after.importSource).toEqual(b.importSource);
    expect(
      await Promise.all(a.pages.map((page) => readFile(page.imagePath))),
    ).toEqual(images);
    expect((await f.library.openChapter(a.id)).pages).toEqual(a.pages);
  } finally {
    await f.close();
  }
});
