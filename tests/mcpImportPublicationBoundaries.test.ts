import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importPublicationFixture } from "./mcpImportPublication.fixture";
import { McpImportCreateSchema } from "../src/shared/mcpLibraryImport";
import { McpImportBatchRecordSchema } from "../src/main/application/mcpImportBatchState";

it("refuses a group containing an independently used preview without importing its unused sibling", async () => {
  const f = await importPublicationFixture(2);
  try {
    const first = f.publication.items[0];
    await f.create(
      McpImportCreateSchema.parse({
        requestId: randomUUID(),
        previewId: first.previewId,
        snapshot: first.snapshot,
        target: f.publication.target,
        allowNativePreparation: true,
        chapters: first.chapters,
      }),
    );
    const before = await f.library.listLibrary();
    const done = await f.settle(
      await f.invoke("carrot_import_batch_chapters", f.publication),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(
      (await f.get(f.publication.id)).items.map((item) => item.status),
    ).toEqual(["imported", "ready"]);
  } finally {
    await f.close();
  }
});

it("refuses expired captured inputs without rescanning or publishing any part", async () => {
  const f = await importPublicationFixture(2);
  try {
    const before = await f.library.listLibrary();
    const second = (await f.get(f.publication.id)).items[1].preview;
    if (!second) throw new Error("Missing preview");
    f.clock(second.expiresAt);
    const expired = await f.settle(
      await f.invoke("carrot_import_batch_chapters", f.publication),
    );
    expect(expired).toMatchObject({
      status: "failed",
      error: { code: "not_found" },
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.web.scan).toHaveBeenCalledTimes(2);
    expect(f.validate).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("validates retained group membership totals order and preview evidence rather than trusting receipt-shaped metadata", async () => {
  const f = await importPublicationFixture(2);
  try {
    await f.publish();
    const original = McpImportBatchRecordSchema.parse(
      await f.storage.record(f.publication.id),
    );
    const variants = Array.from({ length: 6 }, () => structuredClone(original));
    const receipts = variants.map((record) => {
      const receipt = record.items[0].receipt;
      if (!receipt?.batch) throw new Error("Missing grouped receipt");
      return { receipt, batch: receipt.batch };
    });
    receipts[0].batch.items[0].pageCount++;
    receipts[1].batch.items[0].chapterIds = [randomUUID()];
    receipts[2].batch.items[0].itemId = randomUUID();
    receipts[3].batch.items[0].previewId = randomUUID();
    receipts[4].batch.items.reverse();
    variants[5].items[1].receipt = null;
    for (const [index, record] of variants.entries()) {
      if (index < 5)
        record.items[1].receipt = structuredClone(receipts[index].receipt);
      expect(McpImportBatchRecordSchema.safeParse(record).success).toBe(false);
    }
    const path = await f.storage.path(original.id);
    await writeFile(path, JSON.stringify(await f.codec.seal(variants[5])));
    await expect(f.get(original.id)).rejects.toThrow();
    await writeFile(path, JSON.stringify(await f.codec.seal(original)));
    expect((await f.get(original.id)).status).toBe("completed");
  } finally {
    await f.close();
  }
});
