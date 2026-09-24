import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterStoryMemory } from "../src/shared/workContextTypes";
import { libraryOrganizationFixture } from "./mcpLibraryOrganization.fixture";

export async function pageOrganizationFixture() {
  const f = await libraryOrganizationFixture();
  const imported = await f.create(await f.importCommand(await f.prepare()));
  const chapter = await f.library.openChapter(imported.chapterIds[0]);
  const directory = join(f.env.libraryDir, "works", imported.workId);
  const chapterPath = join(directory, "chapters", chapter.id, "chapter.json");
  const memoryPath = join(
    directory,
    "chapters",
    chapter.id,
    "story-memory.json",
  );
  const workPath = join(directory, "work.json");
  const memory: ChapterStoryMemory = {
    schemaVersion: 1,
    workId: imported.workId,
    chapterId: chapter.id,
    updatedAt: "2026-09-01T00:00:00.000Z",
    aiAnalyzedAt: "2026-08-31T00:00:00.000Z",
    pages: chapter.pages.map((page, index) => ({
      pageId: page.id,
      pageName: `old-${index}`,
      pageIndex: index + 4,
      sourceDigest: "Private source",
      translatedDigest: "Private translation",
      summary: `Remembered page ${index}`,
      visualSummary: "Manual scene description",
      visualSummarySource: "manual",
      glossaryEntryIds: ["term"],
      characterIds: ["person"],
      updatedAt: "2026-09-01T00:00:00.000Z",
    })),
  };
  return {
    ...f,
    chapter,
    chapterPath,
    memoryPath,
    workPath,
    memory,
    writeMemory: async (value: ChapterStoryMemory = memory) => {
      await writeFile(memoryPath, JSON.stringify(value, null, 2) + "\n");
      return value;
    },
    readMemory: async () =>
      JSON.parse(await readFile(memoryPath, "utf8")) as ChapterStoryMemory,
    intent: {
      kind: "reorder-pages" as const,
      workId: imported.workId,
      chapterId: chapter.id,
      pageIds: [...chapter.pageOrder].reverse(),
    },
  };
}
