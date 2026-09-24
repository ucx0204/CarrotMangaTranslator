import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { contextHttpFixture } from "./mcpContextHttp.fixture";

it.each(["source", "references"] as const)(
  "rejects app research when another chapter's saved %s changes during the engine boundary",
  async (kind) => {
    const f = await contextHttpFixture();
    try {
      const workDir = join(f.environment.libraryDir, "works", "work");
      const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
      const secondPath = join(workDir, "chapters", "second", "chapter.json");
      const secondImage = join(
        workDir,
        "chapters",
        "second",
        "pages",
        "page.png",
      );
      await mkdir(join(workDir, "chapters", "second", "pages"), {
        recursive: true,
      });
      await copyFile(f.original, secondImage);
      await writeFile(
        secondPath,
        JSON.stringify({
          ...chapter,
          id: "second",
          pages: chapter.pages.map((page: object) => ({
            ...page,
            imagePath: secondImage,
            inpaintedImagePath: undefined,
            inpaintMaskPath: undefined,
          })),
        }),
      );
      const workPath = join(workDir, "work.json");
      const work = JSON.parse(await readFile(workPath, "utf8"));
      await writeFile(
        workPath,
        JSON.stringify({ ...work, chapterOrder: ["chapter", "second"] }),
      );
      await f.library.openChapter("second");
      const original = f.research.getMockImplementation();
      if (!original) throw new Error("Missing external research boundary");
      let edited = "";
      f.research.mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        // Emulate an out-of-process edit; native publication and evidence readers are real.
        const current = JSON.parse(await readFile(secondPath, "utf8"));
        if (kind === "source")
          current.pages[0].blocks[0].sourceText =
            "Later source outside the anchor";
        else current.pages[0].blocks[0].glossaryEntryIds = ["later-reference"];
        edited = JSON.stringify(current);
        await writeFile(secondPath, edited);
        return result;
      });
      const beforeAnchor = await readFile(f.chapterPath);
      const beforeGuide = (await f.library.readWorkContextForEdit("chapter"))
        .styleGuide;
      const response = await f.call("carrot_run_context_research", f.target);
      expect(response.result.isError).toBe(false);
      const job = await f.settle(response.result.structuredContent.jobId);
      expect(
        job,
        f.errors
          .map((error) =>
            error instanceof Error ? error.stack : String(error),
          )
          .join("\n"),
      ).toMatchObject({
        status: "failed",
        error: { code: "revision_conflict" },
      });
      expect(job.result?.contextResearch).toBeUndefined();
      expect(f.research).toHaveBeenCalledOnce();
      expect(await readFile(f.chapterPath)).toEqual(beforeAnchor);
      expect(await readFile(secondPath, "utf8")).toBe(edited);
      const afterGuide = (await f.library.readWorkContextForEdit("chapter"))
        .styleGuide;
      expect(afterGuide.glossary).toEqual(beforeGuide.glossary);
      expect(afterGuide.characters).toEqual(beforeGuide.characters);
      expect(afterGuide.rules).toEqual(beforeGuide.rules);
      expect(f.jobs.gate.activities).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
