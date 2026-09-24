import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { pageOrganizationFixture } from "./mcpLibraryPageOrder.fixture";

it("keeps native partial ordering and last-memory reconciliation, with all page payloads intact", async () => {
  const f = await pageOrganizationFixture();
  try {
    f.memory.pages.push({
      ...f.memory.pages[0],
      summary: "Last duplicate wins",
    });
    f.memory.pages.push({ ...f.memory.pages[0], pageId: "orphan-memory" });
    await f.writeMemory();
    const bytes = await Promise.all(
      f.chapter.pages.map((page) => readFile(page.imagePath)),
    );
    const next = await f.library.reorderPages(f.chapter.id, [
      f.chapter.pageOrder[1],
    ]);
    expect(next.pageOrder).toEqual([...f.chapter.pageOrder].reverse());
    expect(next.pages).toEqual([...f.chapter.pages].reverse());
    expect(next.importSource).toEqual(f.chapter.importSource);
    expect(next.updatedAt > f.chapter.updatedAt).toBe(true);
    const memory = await f.readMemory();
    expect(memory).toEqual({
      ...f.memory,
      updatedAt: next.updatedAt,
      pages: [
        { ...f.memory.pages[1], pageName: next.pages[0].name, pageIndex: 0 },
        { ...f.memory.pages[2], pageName: next.pages[1].name, pageIndex: 1 },
      ],
    });
    expect(
      await Promise.all(
        f.chapter.pages.map((page) => readFile(page.imagePath)),
      ),
    ).toEqual(bytes);
  } finally {
    await f.close();
  }
});

it("does not create an absent memory file or rewrite an unchanged empty memory on native reorder", async () => {
  const f = await pageOrganizationFixture();
  try {
    await f.library.reorderPages(f.chapter.id, f.intent.pageIds);
    await expect(readFile(f.memoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await f.writeMemory({ ...f.memory, pages: [] });
    const before = await readFile(f.memoryPath);
    await f.library.reorderPages(f.chapter.id, f.chapter.pageOrder);
    expect(await readFile(f.memoryPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
