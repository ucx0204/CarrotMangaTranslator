import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../src/shared/pageRevision";

it("runs all selected translations before PNG export in saved page order and retains exact results", async () => {
  const f = await workflowFixture();
  try {
    const before = await f.library.openChapter("chapter");
    const plan = await f.prepare();
    expect(plan.pages.map((page) => page.pageId)).toEqual(["page", "second"]);
    expect(plan.steps.map((step) => [step.stage, step.pageId])).toEqual([
      ["translate", "page"],
      ["translate", "second"],
      ["export-png", "page"],
      ["export-png", "second"],
    ]);
    expect(f.request).not.toHaveBeenCalled();
    const { input } = await f.run(plan.id);
    const result = await f.done(plan.id);
    expect(result.status, JSON.stringify(f.errors)).toBe("completed");
    expect(result.completedSteps).toBe(4);
    const blocks = before.pages.reduce((n, page) => n + page.blocks.length, 0);
    expect(f.request).toHaveBeenCalledTimes(blocks);
    expect(f.render).toHaveBeenCalledTimes(2);
    const after = await f.library.openChapter("chapter");
    for (const [index, page] of after.pages.entries()) {
      expect(page.blockOrder).toEqual(before.pages[index].blockOrder);
      expect(page.blocks.map((block) => block.sourceText)).toEqual(
        before.pages[index].blocks.map((block) => block.sourceText),
      );
      expect(
        page.blocks.every(
          (block) => block.translatedText === `translated ${block.sourceText}`,
        ),
      ).toBe(true);
      expect(await readFile(page.imagePath)).toEqual(
        await readFile(before.pages[index].imagePath),
      );
    }
    expect(result.steps.filter((step) => step.outputId)).toHaveLength(2);
    expect(result.steps.filter((step) => step.changeId)).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(f.env.root);
    await f.restart();
    const repeated = await f.invoke("carrot_resume_workflow", input);
    expect(repeated).toMatchObject({ status: "completed", completedSteps: 4 });
    expect(f.request).toHaveBeenCalledTimes(blocks);
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("persists external waiting and accepts only the exact saved page before explicit continuation", async () => {
  const f = await workflowFixture();
  try {
    const plan = await f.prepare([
      { kind: "await-external", purpose: "translation" },
      { kind: "export-png" },
    ]);
    await f.run(plan.id);
    let state = await f.done(plan.id);
    expect(state.status).toBe("waiting_external");
    await f.restart();
    expect((await f.get(plan.id)).status).toBe("waiting_external");
    await expect(f.run(plan.id)).rejects.toThrow("waiting");
    for (const pageId of ["page", "second"]) {
      state = await f.get(plan.id);
      const before = (await f.library.openChapter("chapter")).pages.find(
        (page) => page.id === pageId,
      );
      if (!before) throw new Error("Missing fixture page");
      await f.invoke("carrot_update_page_blocks", {
        chapterId: "chapter",
        pageId,
        revision: createPageRevision(before),
        edits: [
          {
            blockId: before.blocks[0].id,
            fields: { translatedText: "External saved result" },
          },
        ],
      });
      const page = (await f.library.openChapter("chapter")).pages.find(
        (page) => page.id === pageId,
      );
      if (!page) throw new Error("Missing updated page");
      const input = {
        id: plan.id,
        version: state.version,
        requestId: randomUUID(),
        page: {
          chapterId: "chapter",
          pageId,
          revision: createPageRevision(page),
          reviewRevision: createSoundEffectReviewPageRevision(page),
        },
      };
      await expect(
        f.invoke("carrot_accept_workflow_external", {
          ...input,
          page: { ...input.page, revision: createPageRevision(before) },
        }),
      ).rejects.toThrow();
      expect(
        await f.invoke("carrot_accept_workflow_external", input),
      ).toMatchObject({ status: "paused" });
      await f.invoke("carrot_accept_workflow_external", input);
      await f.run(plan.id);
      state = await f.done(plan.id);
    }
    expect(state.status).toBe("completed");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("pauses only after the current native output settles and resumes remaining pages without rerendering completed ones", async () => {
  const f = await workflowFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const render = f.render.getMockImplementation();
    if (!render) throw new Error("Missing renderer fixture");
    f.render.mockImplementationOnce(async (page) => {
      await gate;
      return render(page);
    });
    const plan = await f.prepare([{ kind: "export-png" }]);
    await f.run(plan.id);
    await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1));
    expect(
      await f.invoke("carrot_pause_workflow", { id: plan.id }),
    ).toMatchObject({ status: "running", pauseRequested: true });
    await expect(
      f.invoke("carrot_discard_workflow", { id: plan.id, confirm: true }),
    ).rejects.toThrow();
    release();
    const paused = await f.done(plan.id);
    expect(paused).toMatchObject({ status: "paused", completedSteps: 1 });
    await f.restart();
    await f.run(plan.id);
    expect(await f.done(plan.id)).toMatchObject({
      status: "completed",
      completedSteps: 2,
    });
    expect(f.render).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await f.close();
  }
});

it("refuses changed source and later page edits without starting a model", async () => {
  const f = await workflowFixture();
  try {
    const plan = await f.prepare();
    const path = (await f.library.openChapter("chapter")).pages[1].imagePath;
    const original = await readFile(path),
      changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await writeFile(path, changed);
    await f.run(plan.id);
    expect(await f.done(plan.id)).toMatchObject({
      status: "failed",
      lastError: "revision_conflict",
      pageAttemptsUsed: 0,
    });
    expect(f.request).not.toHaveBeenCalled();
    await writeFile(path, original);
    f.settings.api.model = "changed-model";
    await f.run(plan.id);
    expect(await f.done(plan.id)).toMatchObject({
      status: "failed",
      lastError: "revision_conflict",
    });
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
