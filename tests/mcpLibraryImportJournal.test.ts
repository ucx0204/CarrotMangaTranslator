import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  persistedMcpJobResult,
  publicMcpJobResult,
  parseMcpJobJournal,
} from "../src/main/application/mcpJobJournal";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";

it("expires input previews exactly at the deadline and never resurrects them through journal serialization", () => {
  const preview = {
    previewId: randomUUID(),
    snapshot: "a".repeat(16),
    source: "local",
    chapterCount: 1,
    pageCount: 2,
    sourceBytes: 100,
    expiresAt: 1000,
    retention: "session-only",
  };
  const input = { status: "prepared", importPreview: preview };
  expect(publicMcpJobResult(input, 999)?.importPreview).toEqual(preview);
  const expired = publicMcpJobResult(input, 1000);
  expect(expired).toMatchObject({ importPreviewExpired: true });
  expect(expired).not.toHaveProperty("importPreview");
  expect(input.importPreview).toEqual(preview);
  const saved = persistedMcpJobResult(input);
  expect(saved).toMatchObject({ importPreviewExpired: true });
  expect(saved).not.toHaveProperty("importPreview");
  expect(persistedMcpJobResult(JSON.parse(JSON.stringify(saved)))).toEqual(
    saved,
  );
});

it("rejects reconstructed import receipts whose request, count or destination no longer matches the admitted command", async () => {
  const f = await libraryImportFixture();
  try {
    const input = await f.command(await f.prepare());
    const target = (await f.invoke("carrot_get_import_target", {
      workId: "work",
    })) as { snapshot: string };
    input.target = {
      mode: "existing",
      workId: "work",
      snapshot: target.snapshot,
    };
    const receipt = await f.create(input);
    await f.restart();
    const journal = JSON.parse(JSON.stringify(f.journal()));
    expect(parseMcpJobJournal(journal)).toBeDefined();
    const index = journal.records.findIndex(
      (record: { requestId: string }) => record.requestId === input.requestId,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    for (const patch of [
      { requestId: randomUUID() },
      { pageCount: 1 },
      { chapterIds: [...receipt.chapterIds, randomUUID()] },
      { workId: "wrong-work" },
    ]) {
      const invalid = structuredClone(journal);
      Object.assign(invalid.records[index].result.importReceipt, patch);
      expect(() => parseMcpJobJournal(invalid)).toThrow();
    }
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.choose).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
