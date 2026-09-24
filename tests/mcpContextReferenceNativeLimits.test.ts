import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { contextReferenceAppFixture as fixture } from "./mcpContextReferenceApp.fixture";

it("refuses a native work inventory beyond one hundred chapters before walking missing entries", async () => {
  const f = await fixture();
  try {
    const work = JSON.parse(await readFile(f.workPath, "utf8"));
    work.chapterOrder = [
      "chapter",
      ...Array.from({ length: 100 }, (_, n) => `bounded-${n}`),
    ];
    await writeFile(f.workPath, JSON.stringify(work));
    const before = await readFile(f.workPath);
    await expect(f.invoke()).rejects.toThrow("reference inspection budget");
    expect(await readFile(f.workPath)).toEqual(before);
    expect(f.prepare).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("refuses a native context snapshot beyond one thousand pages without truncating it", async () => {
  const f = await fixture();
  try {
    const chapter = JSON.parse(await readFile(f.secondPath, "utf8"));
    chapter.pages = Array.from({ length: 1000 }, (_, n) => ({
      ...chapter.pages[0],
      id: `page-${n}`,
      blocks: [],
      blockOrder: [],
    }));
    chapter.pageOrder = chapter.pages.map((page: { id: string }) => page.id);
    await writeFile(f.secondPath, JSON.stringify(chapter));
    const before = await readFile(f.secondPath);
    await expect(f.invoke()).rejects.toThrow("bounded inspection budget");
    expect(await readFile(f.secondPath)).toEqual(before);
    expect(f.prepare).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects a valid chapter resolved from a different work rather than mixing two work inventories", async () => {
  const f = await fixture();
  try {
    const work = JSON.parse(await readFile(f.workPath, "utf8"));
    const chapter = JSON.parse(await readFile(f.secondPath, "utf8"));
    const other = join(f.env.libraryDir, "works", "other-work");
    const directory = join(other, "chapters", "chapter-two");
    await mkdir(join(directory, "pages"), { recursive: true });
    chapter.workId = "other-work";
    for (const page of chapter.pages) {
      page.imagePath = join(directory, "pages", `${page.id}.png`);
      await writeFile(page.imagePath, f.bytes);
    }
    await writeFile(join(directory, "chapter.json"), JSON.stringify(chapter));
    await writeFile(
      join(other, "work.json"),
      JSON.stringify({
        ...work,
        id: "other-work",
        chapterOrder: ["chapter-two"],
      }),
    );
    const paths = await import("../src/main/libraryStore/libraryPaths");
    await writeFile(
      paths.getLibraryIndexPath(),
      JSON.stringify({ workOrder: ["other-work", "work"] }),
    );
    const before = await readFile(f.chapterPath);
    await expect(f.invoke()).rejects.toThrow("complete work inventory");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.prepare).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["guide-work", "memory-work", "memory-chapter"])(
  "refuses a native context transform changing %s identity without publishing files",
  async (kind) => {
    const f = await fixture();
    try {
      const { commitWorkContextEdit } =
        await import("../src/main/library/libraryContextEditingFacade");
      const guidePath = join(
        f.env.libraryDir,
        "works",
        "work",
        "style-guide.json",
      );
      const before = await readFile(guidePath);
      await expect(
        commitWorkContextEdit(
          "chapter",
          (current) => ({
            result: null,
            ...(kind === "guide-work"
              ? { styleGuide: { ...current.styleGuide, workId: "other-work" } }
              : {
                  storyMemory: {
                    ...current.storyMemory,
                    ...(kind === "memory-work"
                      ? { workId: "other-work" }
                      : { chapterId: "other-chapter" }),
                  },
                }),
          }),
          () => {},
        ),
      ).rejects.toThrow("cannot change work or chapter identity");
      expect(await readFile(guidePath)).toEqual(before);
    } finally {
      await f.close();
    }
  },
);
