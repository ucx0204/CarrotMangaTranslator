import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPageRevision } from "../src/shared/pageRevision";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import { makeBlock, makeChapter } from "./unifiedInpaintingUiFixtures";

const roots: string[] = [];
afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("../src/main/appPaths");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

it("commits successive region blocks when export adds a derived mask between requests", async () => {
  const fixture = await createStorage();
  const { page, chapter, append, readStored, chapterPath } = fixture;
  const expectedRevision = createPageRevision(page);
  page.inpaintMaskPath = join(fixture.chapterDir, "derived.png");
  page.maskProvenance = "derived-diff";
  await writeFile(chapterPath, JSON.stringify(chapter));
  const first = await append(chapter.id, page.id, [makeBlock()], {
    expectedRevision,
  });
  expect(first.pages[0]?.inpaintMaskPath).toBe(page.inpaintMaskPath);
  expect((await readStored()).pages[0]?.blocks).toHaveLength(1);
  const latest = first.pages[0];
  if (!latest) throw new Error("Missing saved page");
  await append(chapter.id, page.id, [{ ...makeBlock(), id: "second-block" }], {
    expectedRevision: createPageRevision(latest),
  });
  expect((await readStored()).pages[0]?.blocks).toHaveLength(2);
  await expect(
    append(chapter.id, page.id, [], { expectedRevision }),
  ).rejects.toThrow("페이지가 변경");
});

it.each(["image", "text", "actual-mask"])(
  "rejects a concurrent %s edit without changing the saved chapter",
  async (edit) => {
    const { page, chapter, append, readStored, chapterPath, chapterDir } =
      await createStorage();
    const expectedRevision = createPageRevision(page);
    page.inpaintMaskPath = join(chapterDir, "derived.png");
    page.maskProvenance = "derived-diff";
    if (edit === "image")
      page.inpaintedImagePath = join(chapterDir, "edited.png");
    if (edit === "text") page.blocks = [makeBlock()];
    if (edit === "actual-mask") page.maskProvenance = "actual-mask";
    await writeFile(chapterPath, JSON.stringify(chapter));
    await expect(
      append(chapter.id, page.id, [makeBlock()], { expectedRevision }),
    ).rejects.toThrow("페이지가 변경");
    expect(await readStored()).toEqual(chapter);
  },
);

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), "region-revision-"));
  roots.push(root);
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({ libraryDir: root, logFile: join(root, "app.log") }),
  }));
  const snapshot = makeChapter();
  const chapterDir = join(
    root,
    "works",
    snapshot.workId,
    "chapters",
    snapshot.id,
  );
  await mkdir(chapterDir, { recursive: true });
  const chapter: LibraryChapter = {
    ...snapshot,
    pages: snapshot.pages.map(({ dataUrl: _dataUrl, ...page }) => ({
      ...page,
      imagePath: join(chapterDir, "original.png"),
      inpaintedImagePath: join(chapterDir, "background.png"),
    })),
  };
  const page = chapter.pages[0];
  if (!page) throw new Error("Missing fixture page");
  const chapterPath = join(chapterDir, "chapter.json");
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({ workOrder: [chapter.workId] }),
  );
  await writeFile(
    join(root, "works", chapter.workId, "work.json"),
    JSON.stringify({
      id: chapter.workId,
      title: "test",
      chapterOrder: [chapter.id],
      createdAt: chapter.createdAt,
      updatedAt: chapter.updatedAt,
    }),
  );
  await writeFile(chapterPath, JSON.stringify(chapter));
  const { appendAnalyzedPageBlocksUnlocked: append } =
    await import("../src/main/libraryStore/libraryAnalysisMutations");
  return {
    chapter,
    page,
    chapterDir,
    chapterPath,
    append,
    readStored: async (): Promise<LibraryChapter> =>
      JSON.parse(await readFile(chapterPath, "utf8")),
  };
}
