import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { pageOrganizationFixture } from "./mcpLibraryPageOrder.fixture";

it("reviews native memory reconciliation and restores duplicates, orphan rows and manual descriptions exactly after restart", async () => {
  const f = await pageOrganizationFixture();
  try {
    f.memory.pages.push({
      ...f.memory.pages[0],
      summary: "Last duplicate wins",
    });
    f.memory.pages.push({
      ...f.memory.pages[0],
      pageId: "orphan-memory",
      summary: "Preserve me on Undo",
    });
    await f.writeMemory();
    const originalWork = JSON.parse(await readFile(f.workPath, "utf8"));
    const before = await f.library.openChapter(f.chapter.id);
    const bytes = await Promise.all(
      before.pages.map((page) => readFile(page.imagePath)),
    );
    const preview = await f.preview(f.intent);
    expect(preview.before.pageIds).toEqual(before.pageOrder);
    expect(preview.after.pageIds).toEqual(f.intent.pageIds);
    expect(preview.before.memory?.rows).toHaveLength(4);
    expect(preview.after.memory?.rows).toEqual([
      {
        pageId: before.pages[1].id,
        pageIndex: 0,
        pageName: before.pages[1].name,
      },
      {
        pageId: before.pages[0].id,
        pageIndex: 1,
        pageName: before.pages[0].name,
      },
    ]);
    expect(JSON.stringify(preview)).not.toMatch(
      /Private source|Manual scene|sourceDigest|visualSummary|imagePath|selectionSha256/,
    );
    expect(await f.readMemory()).toEqual(f.memory);
    const input = await f.command(f.intent);
    const saved = await f.apply(input);
    const after = await f.library.openChapter(before.id);
    expect(after.pages).toEqual([...before.pages].reverse());
    expect(after.importSource).toEqual(before.importSource);
    const memoryAfter = await f.readMemory();
    expect(memoryAfter.pages[1].summary).toBe("Last duplicate wins");
    expect(memoryAfter.pages[1].visualSummary).toBe("Manual scene description");
    expect(memoryAfter.aiAnalyzedAt).toBe(f.memory.aiAnalyzedAt);
    await f.restart();
    expect((await f.inspectChange(saved.id)).canUndo).toBe(true);
    await f.recover(saved.id, "undo");
    expect(await f.library.openChapter(before.id)).toEqual(before);
    expect(await f.readMemory()).toEqual(f.memory);
    expect(JSON.parse(await readFile(f.workPath, "utf8"))).toEqual(
      originalWork,
    );
    expect(await f.apply(input)).toMatchObject({ historical: true });
    expect(await f.library.openChapter(before.id)).toEqual(before);
    await f.restart();
    await f.recover(saved.id, "redo");
    expect(await f.library.openChapter(before.id)).toEqual(after);
    expect(await f.readMemory()).toEqual(memoryAfter);
    await f.recover(saved.id, "undo");
    await f.discardChange(saved.id);
    expect(await f.readMemory()).toEqual(f.memory);
    expect(
      await Promise.all(before.pages.map((page) => readFile(page.imagePath))),
    ).toEqual(bytes);
  } finally {
    await f.close();
  }
});

it.each(["missing", "empty"] as const)(
  "keeps %s memory unchanged through page reorder, restart and exact Undo/Redo",
  async (kind) => {
    const f = await pageOrganizationFixture();
    try {
      if (kind === "empty") await f.writeMemory({ ...f.memory, pages: [] });
      const memoryBytes =
        kind === "empty" ? await readFile(f.memoryPath) : null;
      const first = await f.preview(f.intent);
      expect(await f.preview(f.intent)).toEqual(first);
      const saved = await f.apply(await f.command(f.intent));
      await f.restart();
      await f.recover(saved.id, "undo");
      await f.recover(saved.id, "redo");
      if (memoryBytes)
        expect(await readFile(f.memoryPath)).toEqual(memoryBytes);
      else
        await expect(readFile(f.memoryPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      expect((await f.library.openChapter(f.chapter.id)).pageOrder).toEqual(
        f.intent.pageIds,
      );
    } finally {
      await f.close();
    }
  },
);

it("records a no-op without changing timestamps and rejects partial, duplicate, unknown and cross-chapter order", async () => {
  const f = await pageOrganizationFixture();
  try {
    const original = await readFile(f.chapterPath);
    const input = await f.command({
      ...f.intent,
      pageIds: f.chapter.pageOrder,
    });
    expect(await f.apply(input)).toMatchObject({ status: "unchanged" });
    expect(await readFile(f.chapterPath)).toEqual(original);
    for (const pageIds of [
      [],
      [f.chapter.pageOrder[0]],
      [f.chapter.pageOrder[0], f.chapter.pageOrder[0]],
      ["page", "missing"],
    ]) {
      await expect(f.preview({ ...f.intent, pageIds })).rejects.toThrow();
    }
    await expect(f.preview({ ...f.intent, workId: "work" })).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally {
    await f.close();
  }
});

it("keeps a same-order request a no-op even when physical records differ from the canonical page order", async () => {
  const f = await pageOrganizationFixture();
  try {
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    stored.pages.reverse();
    await writeFile(f.chapterPath, JSON.stringify(stored));
    const before = await readFile(f.chapterPath);
    const saved = await f.apply(
      await f.command({ ...f.intent, pageIds: f.chapter.pageOrder }),
    );
    expect(saved.status).toBe("unchanged");
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
