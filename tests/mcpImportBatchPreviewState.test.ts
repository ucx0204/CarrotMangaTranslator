import { expect, it } from "vitest";
import { importBatchFixture } from "./mcpImportBatch.fixture";

async function importedPreviewWithoutReceipt() {
  const f = await importBatchFixture(1);
  try {
    const plan = await f.prepareBatch();
    const scanned = await f.run(plan.id);
    const preview = scanned.view.items[0].preview;
    if (!preview) throw new Error("Missing native preview");
    const receipt = await f.create(await f.command(preview));
    const { McpRetentionCatalog } =
      await import("../src/main/mcp/mcpRetentionCatalog");
    await new McpRetentionCatalog(
      f.storage,
      new AbortController().signal,
      false,
    ).discard("import-owner", receipt.id, () => {});
    // The actual preview service still knows it was imported; receipt disposal
    // neither deletes that in-session fact nor the ordinary imported chapter.
    expect(await f.inspect(preview)).toMatchObject({ status: "imported" });
    return { ...f, plan, receipt };
  } catch (error) {
    await f.close();
    throw error;
  }
}

it("does not describe a known imported native preview as expired just because its independent receipt was discarded", async () => {
  const f = await importedPreviewWithoutReceipt();
  try {
    expect((await f.get(f.plan.id)).items[0]).toMatchObject({
      status: "imported",
      receipt: null,
    });
    expect(f.web.scan).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("rejects an unavailable-preview rescan while the native service still knows the source was imported", async () => {
  const f = await importedPreviewWithoutReceipt();
  try {
    const retry = await f.run(f.plan.id, {
      rescanExpiredItemIds: [f.plan.items[0].id],
      acknowledgeDiscardedReceiptRisk: true,
    });
    expect(retry.done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(f.web.scan).toHaveBeenCalledOnce();
    expect(
      (await f.library.listLibrary()).works.some(
        (work) => work.id === f.receipt.workId,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
