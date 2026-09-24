import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { importPublicationFixture } from "./mcpImportPublication.fixture";
import { McpImportBatchRecordSchema } from "../src/main/application/mcpImportBatchState";
import type { McpImportReceipt } from "../src/shared/mcpLibraryImport";

it("rejects individually corrupted grouped receipt invariants while preserving the valid native checkpoint", async () => {
  const f = await importPublicationFixture(2);
  try {
    await f.publish();
    const original = McpImportBatchRecordSchema.parse(
      await f.storage.record(f.publication.id),
    );
    const reject = (
      change: (
        receipt: McpImportReceipt,
        batch: NonNullable<McpImportReceipt["batch"]>,
      ) => void,
    ) => {
      const value = structuredClone(original);
      const receipt = value.items[0].receipt;
      if (!receipt?.batch) throw new Error("Missing grouped fixture");
      change(receipt, receipt.batch);
      for (const row of value.items) row.receipt = structuredClone(receipt);
      expect(McpImportBatchRecordSchema.safeParse(value).success).toBe(false);
    };
    reject((receipt) => {
      receipt.source = "local";
    });
    reject((_receipt, batch) => {
      batch.id = randomUUID();
    });
    reject((_receipt, batch) => {
      batch.items[1].itemId = randomUUID();
    });
    reject((_receipt, batch) => {
      batch.items[1].previewId = randomUUID();
    });
    reject((_receipt, batch) => {
      batch.items[1].itemId = batch.items[0].itemId;
    });
    reject((_receipt, batch) => {
      batch.items[1].previewId = batch.items[0].previewId;
    });
    reject((receipt, batch) => {
      receipt.chapterIds[1] = receipt.chapterIds[0];
      batch.items[1].chapterIds = [...batch.items[0].chapterIds];
    });
    reject((receipt) => {
      receipt.pageCount--;
    });
    reject((receipt) => {
      receipt.chapterIds.reverse();
    });
    reject((receipt, batch) => {
      batch.items = [batch.items[1]];
      receipt.chapterIds = [...batch.items[0].chapterIds];
      receipt.pageCount = batch.items[0].pageCount;
    });
    expect(await f.storage.record(original.id)).toEqual(original);
    expect((await f.get(original.id)).status).toBe("completed");
  } finally {
    await f.close();
  }
});
