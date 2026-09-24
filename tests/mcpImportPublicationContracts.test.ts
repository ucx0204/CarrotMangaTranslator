import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importPublicationFixture } from "./mcpImportPublication.fixture";
import { McpImportBatchPublishSchema } from "../src/shared/mcpImportPublication";
import { parseMcpJobJournal } from "../src/main/application/mcpJobJournal";

it("rejects malformed duplicate oversized or unreviewed selections without importing or browsing", async () => {
  const f = await importPublicationFixture(2);
  try {
    const base = f.publication;
    const before = await f.library.listLibrary();
    const tooMany = structuredClone(base);
    tooMany.items.forEach((item) => {
      item.chapters[0].pageIds = Array.from({ length: 26 }, () => randomUUID());
    });
    for (const input of [
      { ...base, items: [] },
      { ...base, items: [base.items[0], base.items[0]] },
      { ...base, path: "C:/private" },
      { ...base, allowNetwork: true },
      { ...base, allowNativePreparation: false },
      tooMany,
      { ...base, target: { mode: "existing", workId: "work" } },
    ]) {
      expect(McpImportBatchPublishSchema.safeParse(input).success).toBe(false);
      await expect(
        f.invoke("carrot_import_batch_chapters", input),
      ).rejects.toThrow();
    }
    for (const patch of [
      { version: base.version + 1 },
      { items: [{ ...base.items[0], itemId: randomUUID() }] },
      { items: [{ ...base.items[0], previewId: base.items[1].previewId }] },
      { items: [{ ...base.items[0], snapshot: "0".repeat(16) }] },
      {
        items: [
          {
            ...base.items[0],
            chapters: [
              { ...base.items[0].chapters[0], pageIds: [randomUUID()] },
            ],
          },
        ],
      },
    ]) {
      const done = await f.settle(
        await f.invoke("carrot_import_batch_chapters", {
          ...base,
          ...patch,
          requestId: randomUUID(),
        }),
      );
      expect(done.status).toBe("failed");
    }
    const foreign = await f.settle(
      await f.invoke(
        "carrot_import_batch_chapters",
        { ...base, requestId: randomUUID() },
        f.auth("other"),
      ),
      "other",
    );
    expect(foreign).toMatchObject({
      status: "failed",
      error: { code: "not_found" },
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.web.scan).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it("binds restored journal receipts to each batch item and rejects changed mappings", async () => {
  const f = await importPublicationFixture(2);
  try {
    await f.publish();
    const journal = JSON.parse(JSON.stringify(f.journal()));
    expect(() => parseMcpJobJournal(journal)).not.toThrow();
    const job = journal.records.find(
      (record: { kind: string }) => record.kind === "importBatchCreate",
    );
    if (!job) throw new Error("Missing publication record");
    for (const key of ["itemId", "previewId"] as const) {
      const invalid = structuredClone(journal);
      const record = invalid.records.find(
        (value: { kind: string }) => value.kind === "importBatchCreate",
      );
      record.result.importReceipt.batch.items[0][key] = randomUUID();
      expect(() => parseMcpJobJournal(invalid)).toThrow("inconsistent");
    }
    job.result.importReceipt.batch.items.reverse();
    expect(() => parseMcpJobJournal(journal)).toThrow("inconsistent");
  } finally {
    await f.close();
  }
});

it("rejects a parent checkpoint whose grouped receipt belongs to another batch", async () => {
  const f = await importPublicationFixture(2);
  try {
    await f.publish();
    const original = await f.storage.record(f.publication.id);
    const altered = JSON.parse(JSON.stringify(original));
    altered.items[0].receipt.batch.id = randomUUID();
    await writeFile(
      await f.storage.path(f.publication.id),
      JSON.stringify(await f.codec.seal(altered)),
    );
    await expect(f.get(f.publication.id)).rejects.toThrow();
    await writeFile(
      await f.storage.path(f.publication.id),
      JSON.stringify(await f.codec.seal(original)),
    );
    expect((await f.get(f.publication.id)).status).toBe("completed");
  } finally {
    await f.close();
  }
});
