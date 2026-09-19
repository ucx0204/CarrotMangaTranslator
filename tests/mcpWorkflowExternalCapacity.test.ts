import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";

it("can acknowledge and resume all fifty external pages without exhausting its own action journal", async () => {
  const f = await workflowFixture();
  try {
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    const seed = chapter.pages[0];
    while (chapter.pages.length < 50)
      chapter.pages.push({ ...structuredClone(seed), id: `external-page-${chapter.pages.length + 1}` });
    await writeFile(f.chapterPath, JSON.stringify(chapter));
    const before = await readFile(f.chapterPath);
    const prepared = await f.prepare([{ kind: "await-external", purpose: "translation" }]);
    await f.run(prepared.id);
    for (let index = 0; index < 50; index++) {
      const waiting = await f.done(prepared.id);
      expect(waiting.status).toBe("waiting_external");
      expect(waiting.completedSteps).toBe(index);
      const step = waiting.steps[index];
      const page = waiting.pages.find((page) => page.chapterId === step.chapterId && page.pageId === step.pageId);
      if (!page) throw new Error("Missing acknowledged page");
      await f.invoke("carrot_accept_workflow_external", {
        id: prepared.id, version: waiting.version, requestId: randomUUID(),
        page: { chapterId: page.chapterId, pageId: page.pageId, revision: page.revision, reviewRevision: page.reviewRevision },
      });
      await f.run(prepared.id);
    }
    expect(await f.done(prepared.id)).toMatchObject({ status: "completed", completedSteps: 50, pageAttemptsUsed: 0 });
    await f.restart();
    expect(await f.get(prepared.id)).toMatchObject({ status: "completed", completedSteps: 50 });
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
}, 90000);
