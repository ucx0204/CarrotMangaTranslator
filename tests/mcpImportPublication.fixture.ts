import { randomUUID } from "node:crypto";
import { importBatchFixture } from "./mcpImportBatch.fixture";
import { McpImportBatchPublishSchema } from "../src/shared/mcpImportPublication";
import { McpImportReceiptSchema } from "../src/shared/mcpLibraryImport";

export async function importPublicationFixture(count = 3) {
  const f = await importBatchFixture(count);
  const plan = await f.prepareBatch();
  const prepared = await f.run(plan.id);
  if (prepared.done.status !== "completed")
    throw new Error("Batch preparation failed");
  const input = McpImportBatchPublishSchema.parse({
    id: plan.id,
    version: prepared.view.version,
    requestId: randomUUID(),
    allowNativePreparation: true,
    target: { mode: "new", title: "Reviewed multi-URL work" },
    items: await Promise.all(
      prepared.view.items.map(async (item) => {
        if (!item.preview) throw new Error("Missing prepared item");
        const review = await f.inspect(item.preview);
        return {
          itemId: item.id,
          previewId: item.preview.previewId,
          snapshot: item.preview.snapshot,
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
  const publish = async (value = input, caller = f.auth()) => {
    const done = await f.settle(
      await f.invoke("carrot_import_batch_chapters", value, caller),
      caller.principalId,
    );
    if (done.status !== "completed")
      throw new Error(JSON.stringify({ done, errors: f.errors.map(String) }));
    return McpImportReceiptSchema.parse(done.result?.importReceipt);
  };
  return { ...f, publication: input, publish };
}
