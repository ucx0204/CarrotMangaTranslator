import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { mcpSelectionBatchOutputs } from "../src/shared/mcpSelectionEditing";

// Exceed the native 32-plan capacity using actual sequential saves, not no-op
// proposals (the existing native editor correctly refuses an empty apply).
it("releases only completed workflow child plans while independent history remains available", async () => {
  const f = await workflowFixture();
  const { McpWorkflowCalls } = await import("../src/main/mcp/mcpWorkflowCalls");
  try {
    const before = await f.library.openChapter("chapter");
    const preview = async () => {
      const input = await f.translationInput();
      const page = (await f.library.openChapter("chapter")).pages[0];
      return mcpSelectionBatchOutputs.carrot_preview_selection_batch.parse(
        await f.invoke("carrot_preview_selection_batch", {
          chapterId: "chapter",
          contextRevision: input.contextRevision,
          requestId: randomUUID(),
          reason: "Native child lifetime characterization",
          command: { kind: "references" },
          pages: [{
            pageId: page.id,
            revision: input.pages[0].revision,
            edits: [{
              kind: "references",
              blockId: page.blocks[0].id,
              reason: "Alternate optional glossary list presence",
              glossaryEntryIds: page.blocks[0].glossaryEntryIds === undefined ? [] : null,
            }],
          }],
        }),
      );
    };
    const { waitForEdit, releaseEdit } = f.current().selection;
    if (!waitForEdit || !releaseEdit) throw new Error("Missing owned native lifecycle");
    const independent = await preview();
    const requestId = randomUUID();
    await f.invoke("carrot_apply_selection_batch", { batchId: independent.batchId, requestId });
    await waitForEdit(f.owner, independent.batchId, requestId, new AbortController().signal);
    const calls = new McpWorkflowCalls(
      f.current().tools, f.current().operations, f.owner, () => {}, waitForEdit, releaseEdit,
    );
    for (let n = 0; n < 35; n++) {
      const plan = await preview();
      const id = randomUUID();
      expect(() => releaseEdit("foreign", plan.batchId, id)).toThrow();
      expect(() => releaseEdit(f.owner, plan.batchId, id)).toThrow();
      expect((await calls.applySelection(plan.batchId, id, new AbortController().signal)).status).toBe("completed");
      await expect(f.invoke("carrot_get_selection_batch", { batchId: plan.batchId })).rejects.toThrow();
    }
    expect(await f.invoke("carrot_get_selection_batch", { batchId: independent.batchId })).toMatchObject({ status: "completed" });
    const after = await f.library.openChapter("chapter");
    expect(after.pages.map((page) => page.blocks)).toEqual(before.pages.map((page) => page.blocks));
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
}, 60000);
