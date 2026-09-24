import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { pageOrganizationFixture } from "./mcpLibraryPageOrder.fixture";

it("removes only the selected page and its run directory, reconciles memory and preserves sibling payloads", async () => {
  const f = await pageOrganizationFixture();
  try {
    const [removed, kept] = f.chapter.pages;
    await f.writeMemory();
    const directory = dirname(f.chapterPath);
    const run = join(directory, "runs", "selected-run", "pages", removed.id);
    const sibling = join(directory, "runs", "selected-run", "pages", kept.id);
    await mkdir(run, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(run, "result.bin"), "selected artifact");
    await writeFile(join(sibling, "result.bin"), "other artifact");
    const keptBytes = await readFile(kept.imagePath);
    const next = await f.library.deletePage(f.chapter.id, removed.id);
    expect(next.pageOrder).toEqual([kept.id]);
    expect(next.pages).toEqual([kept]);
    expect(next.importSource).toEqual(f.chapter.importSource);
    expect(next.updatedAt > f.chapter.updatedAt).toBe(true);
    expect((await f.readMemory()).pages).toEqual([
      { ...f.memory.pages[1], pageName: kept.name, pageIndex: 0 },
    ]);
    await expect(lstat(removed.imagePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(run)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(kept.imagePath)).toEqual(keptBytes);
    expect(await readFile(join(sibling, "result.bin"), "utf8")).toBe(
      "other artifact",
    );
  } finally {
    await f.close();
  }
});

it("keeps an absent memory absent, leaves an empty chapter, and treats an absent page as a native no-op", async () => {
  const f = await pageOrganizationFixture();
  try {
    const before = await readFile(f.chapterPath);
    await f.library.deletePage(f.chapter.id, "missing-page");
    expect(await readFile(f.chapterPath)).toEqual(before);
    for (const page of f.chapter.pages)
      await f.library.deletePage(f.chapter.id, page.id);
    const empty = await f.library.openChapter(f.chapter.id);
    expect(empty.pages).toEqual([]);
    expect(empty.pageOrder).toEqual([]);
    expect(
      (await f.library.listLibrary()).works.some(
        (w) => w.id === f.chapter.workId,
      ),
    ).toBe(true);
    await expect(readFile(f.memoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.close();
  }
});

it("preserves original bytes still referenced by another page instead of deleting a shared source", async () => {
  const f = await pageOrganizationFixture();
  try {
    const current = JSON.parse(await readFile(f.chapterPath, "utf8"));
    current.pages[1].imagePath = current.pages[0].imagePath;
    await writeFile(f.chapterPath, JSON.stringify(current));
    const expected = await readFile(current.pages[0].imagePath);
    await f.library.deletePage(f.chapter.id, current.pages[0].id);
    expect(await readFile(current.pages[1].imagePath)).toEqual(expected);
    expect((await f.library.openChapter(f.chapter.id)).pages[0].imagePath).toBe(
      current.pages[1].imagePath,
    );
  } finally {
    await f.close();
  }
});
