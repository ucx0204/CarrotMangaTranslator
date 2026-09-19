import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { McpWorkflowPrepareSchema } from "../src/shared/mcpWorkflow";

it("qualifies identical page IDs by chapter and follows the explicit chapter order", async () => {
  const f = await workflowFixture();
  try {
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    const directory = join(dirname(dirname(f.chapterPath)), "next-chapter");
    await mkdir(join(directory, "pages"), { recursive: true });
    chapter.id = "next-chapter";
    for (const page of chapter.pages) {
      const bytes = await readFile(page.imagePath);
      page.imagePath = join(directory, "pages", `${page.id}.png`);
      await writeFile(page.imagePath, bytes);
    }
    await writeFile(join(directory, "chapter.json"), JSON.stringify(chapter));
    const workPath = join(f.env.libraryDir, "works", "work", "work.json");
    const work = JSON.parse(await readFile(workPath, "utf8"));
    work.chapterOrder.push("next-chapter");
    await writeFile(workPath, JSON.stringify(work));
    const chapters = [];
    for (const chapterId of ["next-chapter", "chapter"]) {
      const saved = await f.library.openChapter(chapterId);
      chapters.push({
        chapterId,
        pages: saved.pages.map((page) => ({
          pageId: page.id,
          revision: createPageRevision(page),
        })),
      });
    }
    const plan = await f.prepare([{ kind: "export-png" }], { chapters });
    expect(
      plan.pages.map((page) => `${page.chapterId}/${page.pageId}`),
    ).toEqual([
      "next-chapter/page",
      "next-chapter/second",
      "chapter/page",
      "chapter/second",
    ]);
    await f.run(plan.id);
    const done = await f.done(plan.id);
    expect(done.status, JSON.stringify(f.errors)).toBe("completed");
    expect(done.steps.every((step) => step.outputId)).toBe(true);
    expect(f.render).toHaveBeenCalledTimes(4);
  } finally {
    await f.close();
  }
});

it("preserves manual translations as explicit no-op outcomes without starting the engine", async () => {
  const f = await workflowFixture();
  try {
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    for (const page of stored.pages)
      for (const block of page.blocks)
        block.translatedText = "Manual translation to preserve";
    await writeFile(f.chapterPath, JSON.stringify(stored));
    const before = await readFile(f.chapterPath);
    const plan = await f.prepare([
      {
        kind: "translate",
        expectedEngine: "openai-api",
        allowExternal: true,
        allowAssetDownloads: false,
        contextMode: "saved",
        preserveExistingTranslations: true,
      },
    ]);
    await f.run(plan.id);
    const done = await f.done(plan.id);
    expect(done.status).toBe("completed");
    expect(
      done.steps.every(
        (step) =>
          step.outcome === "existing_translations_or_empty_sources_preserved",
      ),
    ).toBe(true);
    expect(done.translationRequestsReserved).toBe(0);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rejects aggregate page limits without truncating an explicit chapter target", async () => {
  const f = await workflowFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const { input } = (await f.storage.record(plan.id)) as {
      input: Record<string, unknown>;
    };
    const chapter = (id: string) => ({
      chapterId: id,
      pages: Array.from({ length: 30 }, (_, n) => ({
        pageId: `page-${n}`,
        revision: "page-v1:0000000000000000",
      })),
    });
    expect(
      McpWorkflowPrepareSchema.safeParse({
        ...input,
        chapters: [chapter("first"), chapter("second")],
      }).success,
    ).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
