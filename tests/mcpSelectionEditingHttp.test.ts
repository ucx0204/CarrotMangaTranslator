import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { selectionHttpFixture } from "./mcpSelectionHttp.fixture";
import {
  McpSelectionBatchPreviewSchema,
  mcpSelectionBatchOutputs,
} from "../src/shared/mcpSelectionEditing";
import { mcpSelectionAnalysisOutputs } from "../src/shared/mcpSelectionAnalysis";

async function fixture() {
  const f = await selectionHttpFixture(true);
  const inspect = async (batchId: string) =>
    mcpSelectionBatchOutputs.carrot_get_selection_batch.parse(
      (await f.call("carrot_get_selection_batch", { batchId })).body.result
        .structuredContent,
    );
  const done = async (batchId: string) => {
    await vi.waitFor(
      async () => {
        if ((await inspect(batchId)).status === "running")
          throw new Error("Pending selection action");
      },
      { timeout: 5000 },
    );
    return inspect(batchId);
  };
  const analyze = async () => {
    const accepted = (
      await f.call(
        "carrot_run_selection_translation",
        await f.translationInput(),
      )
    ).body.result.structuredContent;
    const job = await f.settle(accepted.jobId, f.principal);
    expect(job.status).toBe("completed");
    const evidence =
      mcpSelectionAnalysisOutputs.carrot_get_selection_analysis.parse(
        (
          await f.call("carrot_get_selection_analysis", {
            analysisId: job.jobId,
          })
        ).body.result.structuredContent,
      );
    const base = await f.input();
    return McpSelectionBatchPreviewSchema.parse({
      ...base,
      command: { kind: "analysis", analysisId: job.jobId },
      reason: "Reviewed HTTP selection",
      pages: base.pages.map(({ blockIds: _ids, ...page }) => {
        const item = evidence.items.find((item) => item.pageId === page.pageId);
        if (!item) throw new Error("Missing fixture observation");
        return {
          ...page,
          edits: [
            { kind: "translation", itemId: item.itemId, reason: "Chosen item" },
          ],
        };
      }),
    });
  };
  return { ...f, inspect, done, analyze };
}

it("runs preview apply undo redo through real scoped HTTP and publishes only validated public results", async () => {
  const f = await fixture();
  try {
    const before = await f.library.openChapter("chapter");
    const input = await f.analyze();
    const response = (await f.call("carrot_preview_selection_batch", input))
      .body.result;
    expect(response.isError).toBe(false);
    expect(JSON.parse(response.content[0].text)).toEqual(
      response.structuredContent,
    );
    const batchId = response.structuredContent.batchId;
    expect(JSON.stringify(await f.inspect(batchId))).not.toMatch(
      /beforeBlock|afterBlock|imagePath|fixture-key|sourceHash/,
    );
    for (const direction of ["apply", "undo", "redo"] as const) {
      const accepted = (
        await f.call(`carrot_${direction}_selection_batch`, {
          batchId,
          requestId: randomUUID(),
        })
      ).body.result;
      expect(accepted.isError).toBe(false);
      expect(accepted.structuredContent.status).toBe("accepted");
      expect((await f.done(batchId)).status).toBe("completed");
      if (direction === "undo")
        expect(
          (await f.library.openChapter("chapter")).pages.map(
            (page) => page.blocks,
          ),
        ).toEqual(before.pages.map((page) => page.blocks));
    }
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.collect).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("requires editing scope for preview and mutation, rejects unknown input, and conceals foreign analysis and plans", async () => {
  const f = await fixture();
  try {
    const input = await f.analyze();
    const before = await readFile(f.chapterPath);
    for (const token of [f.read, f.processOnly])
      expect(
        (await f.call("carrot_preview_selection_batch", input, token)).body
          .error.code,
      ).toBe(-32602);
    expect(
      (
        await f.call("carrot_preview_selection_batch", {
          ...input,
          rawBlocks: [],
        })
      ).body.error.code,
    ).toBe(-32602);
    expect(
      (await f.call("carrot_preview_selection_batch", input, f.other)).body
        .result.structuredContent.error,
    ).toBe("not_found");
    const plan = (await f.call("carrot_preview_selection_batch", input)).body
      .result.structuredContent;
    for (const direction of ["apply", "undo", "redo", "cancel"])
      expect(
        (
          await f.call(
            `carrot_${direction}_selection_batch`,
            { batchId: plan.batchId, requestId: randomUUID() },
            f.processOnly,
          )
        ).body.error.code,
      ).toBe(-32602);
    expect(
      (
        await f.call(
          "carrot_get_selection_batch",
          { batchId: plan.batchId },
          f.other,
        )
      ).body.result.structuredContent.error,
    ).toBe("not_found");
    expect(await readFile(f.chapterPath)).toEqual(before);
    f.provider.revokeConnection(f.principal);
    expect(
      (
        await f.call("carrot_apply_selection_batch", {
          batchId: plan.batchId,
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(401);
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rechecks revocation before the next native page save and retains the first committed receipt", async () => {
  const f = await fixture();
  try {
    const input = await f.analyze();
    const before = await f.library.openChapter("chapter");
    const plan = (await f.call("carrot_preview_selection_batch", input)).body
      .result.structuredContent;
    f.editing.notifySaved.mockImplementationOnce(() => {
      f.provider.revokeConnection(f.principal);
    });
    expect(
      (
        await f.call("carrot_apply_selection_batch", {
          batchId: plan.batchId,
          requestId: randomUUID(),
        })
      ).body.result.isError,
    ).toBe(false);
    await vi.waitFor(() =>
      expect(f.editing.notifySaved).toHaveBeenCalledOnce(),
    );
    await f.session.close();
    const after = await f.library.openChapter("chapter");
    expect(after.pages[0].blocks[0].translatedText).not.toBe(
      before.pages[0].blocks[0].translatedText,
    );
    expect(after.pages[1].blocks).toEqual(before.pages[1].blocks);
    expect(
      (await f.call("carrot_get_selection_batch", { batchId: plan.batchId }))
        .status,
    ).toBe(401);
  } finally {
    await f.close();
  }
});
