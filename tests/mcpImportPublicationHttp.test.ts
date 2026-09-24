import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { libraryImportHttpFixture } from "./mcpLibraryImportHttp.fixture";
import { importWebBoundary } from "./mcpLibraryImportWeb.fixture";
import { McpImportBatchPublishSchema } from "../src/shared/mcpImportPublication";
import { mcpImportBatchOutputs } from "../src/shared/mcpImportBatch";
import { mcpLibraryImportOutputs } from "../src/shared/mcpLibraryImport";

async function fixture() {
  let paths: string[] = [];
  const web = importWebBoundary(() => paths);
  const f = await libraryImportHttpFixture({ web });
  paths = f.originals;
  const created = await f.call("carrot_prepare_import_batch", {
    requestId: randomUUID(),
    sources: [1, 2].map((index) => ({
      kind: "url",
      url: `https://example.com/part/${index}`,
      label: `Part ${index}`,
    })),
  });
  const plan = mcpImportBatchOutputs.carrot_prepare_import_batch.parse(
    created.result.structuredContent,
  );
  const run = await f.call("carrot_run_import_batch", {
    id: plan.id,
    version: plan.version,
    requestId: randomUUID(),
    allowNetwork: true,
  });
  expect((await f.settle(run.result.structuredContent)).status).toBe(
    "completed",
  );
  const ready = mcpImportBatchOutputs.carrot_get_import_batch.parse(
    (await f.call("carrot_get_import_batch", { id: plan.id })).result
      .structuredContent,
  );
  const items = [];
  for (const item of ready.items) {
    if (!item.preview) throw new Error("Missing prepared preview");
    const preview = item.preview;
    const page = mcpLibraryImportOutputs.carrot_get_import_preview.parse(
      (
        await f.call("carrot_get_import_preview", {
          previewId: preview.previewId,
          snapshot: preview.snapshot,
        })
      ).result.structuredContent,
    ).pages[0];
    items.push({
      itemId: item.id,
      previewId: preview.previewId,
      snapshot: preview.snapshot,
      chapters: [
        { draftId: page.draftId, title: item.label, pageIds: [page.pageId] },
      ],
    });
  }
  const input = McpImportBatchPublishSchema.parse({
    id: ready.id,
    version: ready.version,
    requestId: randomUUID(),
    allowNativePreparation: true,
    target: { mode: "new", title: "HTTP reviewed group" },
    items,
  });
  return { ...f, web, input };
}

it("publishes through OAuth and restores exact grouped receipts without granting read-only or foreign access", async () => {
  const f = await fixture();
  try {
    expect(
      (await f.call("carrot_import_batch_chapters", f.input, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call("carrot_import_batch_chapters", {
          ...f.input,
          paths: ["C:/private"],
        })
      ).error.code,
    ).toBe(-32602);
    expect(
      (await f.call("carrot_get_import_batch", { id: f.input.id }, f.other))
        .result.isError,
    ).toBe(true);
    const accepted = await f.call("carrot_import_batch_chapters", f.input);
    expect(accepted.result.isError).toBe(false);
    const done = await f.settle(accepted.result.structuredContent);
    expect(done.status).toBe("completed");
    const receipt = done.result?.importReceipt;
    expect(receipt?.batch?.items).toHaveLength(2);
    const view = (await f.call("carrot_get_import_batch", { id: f.input.id }))
      .result.structuredContent;
    expect(view.status).toBe("completed");
    expect(JSON.stringify({ done, view })).not.toMatch(
      /sourcePath|authorized-input|dataUrl|mgt-import-preview/,
    );
    expect(
      (
        await f.call(
          "carrot_get_import_receipt",
          { requestId: f.input.requestId },
          f.other,
        )
      ).result.isError,
    ).toBe(true);
    await f.restart();
    const replay = await f.call("carrot_import_batch_chapters", f.input);
    expect(
      (await f.settle(replay.result.structuredContent)).result?.importReceipt,
    ).toEqual(receipt);
    expect(f.web.scan).toHaveBeenCalledTimes(2);
    expect(f.validate).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it("rolls back grouped native publication when its actual OAuth connection is revoked during encryption", async () => {
  const f = await fixture();
  const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
  if (!owner) throw new Error("Missing fixture owner");
  try {
    const before = await f.library.listLibrary();
    const index = await f.storage.index();
    const parent = await f.storage.record(f.input.id);
    const seal = f.codec.seal.bind(f.codec);
    const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const encrypted = await seal(value);
      if (value && typeof value === "object" && "receipt" in value)
        f.provider.revokeConnection(owner);
      return encrypted;
    });
    const accepted = await f.call("carrot_import_batch_chapters", f.input);
    const done = await f
      .current()
      .operations.waitForCompletion(
        accepted.result.structuredContent.jobId,
        owner,
        new AbortController().signal,
      );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "access_denied" },
    });
    hook.mockRestore();
    expect(await f.library.listLibrary()).toEqual(before);
    expect(await f.storage.index()).toEqual(index);
    expect(await f.storage.record(f.input.id)).toEqual(parent);
    expect(f.validate).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});
