import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpWorkflowOutputs } from "../src/shared/mcpWorkflow";

it("registers real desktop workflow tools and keeps existing OCR blocks intact across reconstruction", async () => {
  const f = await retentionFixture();
  try {
    const names = Object.keys(mcpWorkflowOutputs);
    expect(names).toHaveLength(9);
    expect(f.tools().filter((tool) => names.includes(tool.name))).toHaveLength(
      9,
    );
    const chapter = await f.snapshot();
    const before = await readFile(f.chapterPath);
    const plan = mcpWorkflowOutputs.carrot_prepare_workflow.parse(
      (
        await f.invoke("carrot_prepare_workflow", {
          requestId: randomUUID(),
          reason: "Actual desktop composition",
          stages: [
            { kind: "ocr", allowAssetDownloads: true },
            { kind: "await-external", purpose: "translation" },
          ],
          chapters: [
            {
              chapterId: "chapter",
              pages: chapter.pages.map((page) => ({
                pageId: page.id,
                revision: createPageRevision(page),
              })),
            },
          ],
        })
      ).structuredContent,
    );
    await f.invoke("carrot_run_workflow", {
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
    });
    await vi.waitFor(
      async () => {
        const result = mcpWorkflowOutputs.carrot_get_workflow.parse(
          (await f.invoke("carrot_get_workflow", { id: plan.id }))
            .structuredContent,
        );
        expect(result.status).toBe("waiting_external");
        expect(
          result.steps
            .slice(0, 2)
            .every((step) => step.outcome === "existing_blocks_preserved"),
        ).toBe(true);
      },
      { timeout: 10000 },
    );
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.app.jobs.all).toEqual([]);
    await f.restart();
    expect(
      (await f.invoke("carrot_get_workflow", { id: plan.id }))
        .structuredContent,
    ).toMatchObject({ status: "waiting_external", completedSteps: 2 });
    await expect(
      f.invoke("carrot_discard_retained", { id: plan.id, confirm: true }),
    ).rejects.toThrow("discard_workflow");
    await f.invoke("carrot_discard_workflow", { id: plan.id, confirm: true });
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rejects inconsistent stored target lists and attempt counters", async () => {
  const f = await retentionFixture();
  const { McpWorkflowRecordSchema } =
    await import("../src/main/application/mcpWorkflowPolicy");
  try {
    const chapter = await f.snapshot();
    const plan = mcpWorkflowOutputs.carrot_prepare_workflow.parse(
      (
        await f.invoke("carrot_prepare_workflow", {
          requestId: randomUUID(),
          reason: "Stored plan invariants",
          stages: [{ kind: "export-png" }],
          chapters: [
            {
              chapterId: "chapter",
              pages: chapter.pages.map((page) => ({
                pageId: page.id,
                revision: createPageRevision(page),
              })),
            },
          ],
        })
      ).structuredContent,
    );
    const record = McpWorkflowRecordSchema.parse(
      await f.storage.record(plan.id),
    );
    expect(
      McpWorkflowRecordSchema.safeParse({ ...record, pageAttemptsUsed: 1 })
        .success,
    ).toBe(false);
    expect(
      McpWorkflowRecordSchema.safeParse({ ...record, status: "completed" })
        .success,
    ).toBe(false);
    const altered = structuredClone(record);
    altered.pages[0].pageId = "unrequested";
    altered.steps[0].pageId = "unrequested";
    expect(McpWorkflowRecordSchema.safeParse(altered).success).toBe(false);
  } finally {
    await f.close();
  }
});
