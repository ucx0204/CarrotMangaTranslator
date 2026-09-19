import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { mcpSelectionBatchOutputs } from "../src/shared/mcpSelectionEditing";

async function referencePlan(f: Awaited<ReturnType<typeof workflowFixture>>) {
  const input = await f.translationInput();
  const page = (await f.library.openChapter("chapter")).pages[0];
  return mcpSelectionBatchOutputs.carrot_preview_selection_batch.parse(
    await f.invoke("carrot_preview_selection_batch", {
      chapterId: "chapter", contextRevision: input.contextRevision,
      requestId: randomUUID(), reason: "Native child cancellation",
      command: { kind: "references" },
      pages: [{ pageId: page.id, revision: input.pages[0].revision, edits: [{
        kind: "references", blockId: page.blocks[0].id,
        reason: "Explicit optional-reference edit",
        glossaryEntryIds: page.blocks[0].glossaryEntryIds === undefined ? [] : null,
      }] }],
    }),
  );
}

it("observes pre-aborted child waits but holds native ownership until the actual save boundary settles", async () => {
  const f = await workflowFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = vi.fn();
  try {
    const before = await readFile(f.chapterPath);
    const plan = await referencePlan(f);
    const { waitForEdit: wait, releaseEdit: retire } = f.current().selection;
    if (!wait || !retire) throw new Error("Missing owned child lifecycle");
    const requestId = randomUUID();
    await expect(wait(f.owner, plan.batchId, requestId, AbortSignal.abort())).rejects.toThrow();
    f.editing.assertWritable.mockImplementation(async () => { entered(); await gate; });
    await f.invoke("carrot_apply_selection_batch", { batchId: plan.batchId, requestId });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    expect(() => retire(f.owner, plan.batchId, requestId)).toThrow();
    await expect(wait("foreign", plan.batchId, requestId, AbortSignal.abort())).rejects.toThrow();
    await expect(wait(f.owner, plan.batchId, randomUUID(), AbortSignal.abort())).rejects.toThrow();
    const finished = vi.fn();
    const waiting = wait(f.owner, plan.batchId, requestId, AbortSignal.abort()).then((value) => { finished(); return value; });
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    release();
    expect((await waiting).status).toBe("cancelled");
    expect((await wait(f.owner, plan.batchId, requestId, AbortSignal.abort())).status).toBe("cancelled");
    expect(() => retire(f.owner, plan.batchId, requestId)).toThrow();
    expect(() => retire(f.owner, randomUUID(), requestId)).toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    release();
    await f.close();
  }
});
