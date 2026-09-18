import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import { selectionAppFixture } from "./mcpSelectionApp.fixture";
import {
  McpSelectionBatchPreviewSchema,
  mcpSelectionBatchOutputs,
} from "../src/shared/mcpSelectionEditing";

export async function selectionEditingFixture() {
  const f = await selectionAppFixture(true);
  const snapshot = () => f.library.openChapter("chapter");
  const inspect = async (batchId: string) =>
    mcpSelectionBatchOutputs.carrot_get_selection_batch.parse(
      await f.invoke("carrot_get_selection_batch", { batchId }),
    );
  const done = async (batchId: string) => {
    await vi.waitFor(
      async () => {
        if ((await inspect(batchId)).status === "running")
          throw new Error("Batch pending");
      },
      { timeout: 5000 },
    );
    return inspect(batchId);
  };
  const action = async (
    batchId: string,
    direction: "apply" | "undo" | "redo",
    requestId = randomUUID(),
  ) => {
    const receipt = await f.invoke(`carrot_${direction}_selection_batch`, {
      batchId,
      requestId,
    });
    return { receipt, result: await done(batchId) };
  };
  const prepare = async (
    kind: "source" | "translation" | "append",
    allPages = true,
  ) => {
    const args =
      kind === "translation" ? await f.translationInput() : await f.ocrInput();
    const run = await f.run(
      kind === "translation"
        ? "carrot_run_selection_translation"
        : "carrot_run_selection_ocr",
      args,
    );
    if (run.job.status !== "completed")
      throw new Error(JSON.stringify(run.job.error));
    const evidence = await f.get(run.job.jobId);
    const base = await f.input();
    const input = McpSelectionBatchPreviewSchema.parse({
      ...base,
      reason: "Review selected observations without unrelated writes",
      command: { kind: "analysis", analysisId: run.job.jobId },
      pages: base.pages
        .slice(0, allPages ? undefined : 1)
        .map(({ blockIds: _ids, ...page }) => {
          const item = evidence.items.find(
            (item) =>
              item.pageId === page.pageId &&
              (kind === "append"
                ? item.regionId !== null
                : item.blockId !== null),
          );
          if (!item) throw new Error("Fixture observation missing");
          const edit =
            kind === "append"
              ? {
                  kind,
                  itemId: item.itemId,
                  sequence: 0,
                  allowOverlap: true,
                  afterBlockId: null,
                  reason: "Reviewed discovery",
                }
              : { kind, itemId: item.itemId, reason: "Reviewed observation" };
          return { ...page, edits: [edit] };
        }),
    });
    return { input, evidence, job: run.job };
  };
  const preview = async (input: unknown) =>
    mcpSelectionBatchOutputs.carrot_preview_selection_batch.parse(
      await f.invoke(
        "carrot_preview_selection_batch",
        McpSelectionBatchPreviewSchema.parse(input),
      ),
    );
  const mutateStored = async (
    modify: (chapter: Awaited<ReturnType<typeof snapshot>>) => void,
  ) => {
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    modify(stored);
    await writeFile(f.chapterPath, JSON.stringify(stored));
  };
  const references = async (
    edit: Record<string, unknown> = { speakerId: null, glossaryEntryIds: [] },
  ) => {
    const base = await f.input();
    return McpSelectionBatchPreviewSchema.parse({
      ...base,
      command: { kind: "references" },
      reason: "Explicit block reference edit",
      pages: base.pages.map(({ blockIds, ...page }) => ({
        ...page,
        edits: [
          {
            kind: "references",
            blockId: blockIds[0],
            reason: "Chosen native IDs",
            ...edit,
          },
        ],
      })),
    });
  };
  return {
    ...f,
    snapshot,
    inspect,
    done,
    action,
    prepare,
    preview,
    mutateStored,
    references,
  };
}
