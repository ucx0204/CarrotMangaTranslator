import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";

it("finishes identical translation proposals without an ineligible native apply or page rewrite", async () => {
  const f = await workflowFixture();
  try {
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    for (const page of chapter.pages)
      for (const block of page.blocks)
        block.translatedText = `translated ${block.sourceText}`;
    await writeFile(f.chapterPath, JSON.stringify(chapter));
    const before = await readFile(f.chapterPath);
    const plan = await f.prepare();
    await f.run(plan.id);
    const result = await f.done(plan.id);
    expect(result.status, JSON.stringify(f.errors)).toBe("completed");
    expect(
      result.steps
        .filter((step) => step.stage === "translate")
        .every(
          (step) =>
            step.outcome === "no_translation_changes" && step.changeId === null,
        ),
    ).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(
      chapter.pages.reduce(
        (count: number, page: { blocks: unknown[] }) =>
          count + page.blocks.length,
        0,
      ),
    );
    expect(f.render).toHaveBeenCalledTimes(chapter.pages.length);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(
      (await f.storage.index()).entries.some(
        (entry) => entry.kind === "change",
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
