import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { importBatchFixture } from "./mcpImportBatch.fixture";
import { McpImportBatchPublishSchema } from "../src/shared/mcpImportPublication";

it("publishes recovered partial scan results while preserving earlier failures and successful previews", async () => {
  const f = await importBatchFixture(2);
  try {
    f.web.scan.mockResolvedValueOnce({
      status: "rejected",
      reason: "page-unavailable",
    });
    const plan = await f.prepareBatch();
    const first = await f.run(plan.id);
    expect(first.view.items.map((item) => item.status)).toEqual([
      "failed",
      "ready",
    ]);
    const successfulPreview = first.view.items[1].preview;
    const resumed = await f.run(plan.id, {
      retryItemIds: [first.view.items[0].id],
    });
    expect(resumed.view.items[1].preview).toEqual(successfulPreview);
    expect(f.web.scan).toHaveBeenCalledTimes(3);
    const input = McpImportBatchPublishSchema.parse({
      id: plan.id,
      version: resumed.view.version,
      requestId: randomUUID(),
      target: { mode: "new", title: "Recovered reviewed group" },
      allowNativePreparation: true,
      items: await Promise.all(
        resumed.view.items.map(async (item) => {
          if (!item.preview) throw new Error("Missing recovered preview");
          const preview = item.preview;
          const review = await f.inspect(preview);
          return {
            itemId: item.id,
            previewId: preview.previewId,
            snapshot: preview.snapshot,
            chapters: [
              {
                draftId: review.pages[0].draftId,
                title: item.label,
                pageIds: review.pages.map((page) => page.pageId),
              },
            ],
          };
        }),
      ),
    });
    const done = await f.settle(
      await f.invoke("carrot_import_batch_chapters", input),
    );
    expect(done.status).toBe("completed");
    expect(done.result?.importReceipt?.chapterIds).toHaveLength(2);
    await f.restart();
    const restored = await f.get(plan.id);
    expect(restored.status).toBe("completed");
    expect(restored.items.map((item) => item.attemptCount)).toEqual([2, 1]);
    expect(
      restored.items.every((item) => item.receipt?.batch?.id === plan.id),
    ).toBe(true);
    expect(f.web.scan).toHaveBeenCalledTimes(3);
    expect(f.validate).toHaveBeenCalledTimes(4);
  } finally {
    await f.close();
  }
});
