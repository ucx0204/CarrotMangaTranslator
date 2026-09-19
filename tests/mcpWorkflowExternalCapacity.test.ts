import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { MCP_WORKFLOW_ACTION_CAPACITY } from "../src/shared/mcpWorkflow";
import { McpWorkflowRecordSchema } from "../src/main/application/mcpWorkflowPolicy";

it("can acknowledge and resume all fifty external pages without exhausting its own action journal", async () => {
  const f = await workflowFixture();
  try {
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    const seed = chapter.pages[0];
    while (chapter.pages.length < 50)
      chapter.pages.push({
        ...structuredClone(seed),
        id: `external-page-${chapter.pages.length + 1}`,
      });
    await writeFile(f.chapterPath, JSON.stringify(chapter));
    const before = await readFile(f.chapterPath);
    const prepared = await f.prepare([
      { kind: "await-external", purpose: "translation" },
    ]);
    await f.run(prepared.id);
    for (let index = 0; index < 50; index++) {
      const waiting = await f.done(prepared.id);
      expect(waiting.status).toBe("waiting_external");
      expect(waiting.completedSteps).toBe(index);
      const step = waiting.steps[index];
      const page = waiting.pages.find(
        (page) =>
          page.chapterId === step.chapterId && page.pageId === step.pageId,
      );
      if (!page) throw new Error("Missing acknowledged page");
      await f.invoke("carrot_accept_workflow_external", {
        id: prepared.id,
        version: waiting.version,
        requestId: randomUUID(),
        page: {
          chapterId: page.chapterId,
          pageId: page.pageId,
          revision: page.revision,
          reviewRevision: page.reviewRevision,
        },
      });
      await f.run(prepared.id);
    }
    expect(await f.done(prepared.id)).toMatchObject({
      status: "completed",
      completedSteps: 50,
      pageAttemptsUsed: 0,
    });
    await f.restart();
    expect(await f.get(prepared.id)).toMatchObject({
      status: "completed",
      completedSteps: 50,
    });
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
  // Actual 101 encrypted native admissions plus 50-page evidence validation.
}, 180000);

it("keeps the raised action journal bounded and refuses new work when it is full", async () => {
  const f = await workflowFixture();
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  try {
    const prepared = await f.prepare([{ kind: "export-png" }]);
    const record = McpWorkflowRecordSchema.parse(
      await f.storage.record(prepared.id),
    );
    record.requests = Array.from(
      { length: MCP_WORKFLOW_ACTION_CAPACITY },
      () => ({
        requestId: randomUUID(),
        fingerprint: "0".repeat(16),
      }),
    );
    expect(MCP_WORKFLOW_ACTION_CAPACITY).toBe(128);
    expect(McpWorkflowRecordSchema.safeParse(record).success).toBe(true);
    expect(
      McpWorkflowRecordSchema.safeParse({
        ...record,
        requests: [
          ...record.requests,
          { requestId: randomUUID(), fingerprint: "0".repeat(16) },
        ],
      }).success,
    ).toBe(false);
    await withLibraryMutation(() =>
      runLibraryTransaction(
        "workflow-capacity-fixture",
        async (transaction) => {
          await f.storage.stageRecord(transaction, prepared.id, record);
        },
      ),
    );
    const before = await readFile(f.chapterPath);
    await expect(f.run(prepared.id)).rejects.toThrow("action receipt limit");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
