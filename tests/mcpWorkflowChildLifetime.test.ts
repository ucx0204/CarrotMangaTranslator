import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { mcpSelectionAnalysisOutputs } from "../src/shared/mcpSelectionAnalysis";
import { mcpSelectionBatchOutputs } from "../src/shared/mcpSelectionEditing";

it("releases only completed workflow child plans so native 32-plan memory limits do not truncate longer workflows", async () => {
  const f = await workflowFixture();
  const { McpWorkflowCalls } = await import("../src/main/mcp/mcpWorkflowCalls");
  try {
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    for (const page of stored.pages)
      for (const block of page.blocks)
        block.translatedText = `translated ${block.sourceText}`;
    await writeFile(f.chapterPath, JSON.stringify(stored));
    const before = await readFile(f.chapterPath);
    const input = await f.translationInput();
    input.pages = [input.pages[0]];
    const receipt = (await f.invoke(
      "carrot_run_selection_translation",
      input,
    )) as { jobId: string };
    const job = await f
      .current()
      .operations.waitForCompletion(
        receipt.jobId,
        f.owner,
        new AbortController().signal,
      );
    const analysisId = job.result?.selectionAnalysis?.analysisId;
    if (!analysisId) throw new Error("Missing analysis reference");
    const analysis =
      mcpSelectionAnalysisOutputs.carrot_get_selection_analysis.parse(
        await f.invoke("carrot_get_selection_analysis", { analysisId }),
      );
    const item = analysis.items.find(
      (item) => !item.excludedReason && item.translation,
    );
    if (!item) throw new Error("Missing unchanged translation proposal");
    const preview = async () =>
      mcpSelectionBatchOutputs.carrot_preview_selection_batch.parse(
        await f.invoke("carrot_preview_selection_batch", {
          chapterId: "chapter",
          contextRevision: input.contextRevision,
          requestId: randomUUID(),
          reason: "Child lifetime characterization",
          command: { kind: "analysis", analysisId },
          pages: [
            {
              pageId: input.pages[0].pageId,
              revision: input.pages[0].revision,
              edits: [
                {
                  kind: "translation",
                  itemId: item.itemId,
                  reason: "Unchanged model text",
                },
              ],
            },
          ],
        }),
      );
    const { waitForEdit, releaseEdit } = f.current().selection;
    if (!waitForEdit || !releaseEdit)
      throw new Error("Missing owned native lifecycle");
    const independent = await preview();
    const requestId = randomUUID();
    await f.invoke("carrot_apply_selection_batch", {
      batchId: independent.batchId,
      requestId,
    });
    await waitForEdit(
      f.owner,
      independent.batchId,
      requestId,
      new AbortController().signal,
    );
    const calls = new McpWorkflowCalls(
      f.current().tools,
      f.current().operations,
      f.owner,
      () => {},
      waitForEdit,
      releaseEdit,
    );
    for (let n = 0; n < 35; n++) {
      const plan = await preview();
      const id = randomUUID();
      expect(() => releaseEdit("foreign", plan.batchId, id)).toThrow();
      expect(() => releaseEdit(f.owner, plan.batchId, id)).toThrow();
      expect(
        (
          await calls.applySelection(
            plan.batchId,
            id,
            new AbortController().signal,
          )
        ).status,
      ).toBe("completed");
      await expect(
        f.invoke("carrot_get_selection_batch", { batchId: plan.batchId }),
      ).rejects.toThrow();
    }
    expect(
      await f.invoke("carrot_get_selection_batch", {
        batchId: independent.batchId,
      }),
    ).toMatchObject({ status: "completed" });
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).toHaveBeenCalledTimes(input.pages[0].blockIds.length);
  } finally {
    await f.close();
  }
});
