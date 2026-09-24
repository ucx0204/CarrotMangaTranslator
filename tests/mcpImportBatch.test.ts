import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importBatchFixture } from "./mcpImportBatch.fixture";
import { McpImportBatchRunSchema } from "../src/shared/mcpImportBatch";

it("fixes URL order without browsing, prepares sequential previews and reconciles a real reviewed import across restart", async () => {
  const f = await importBatchFixture();
  try {
    const original = await readFile(f.originals[0]);
    const plan = await f.prepareBatch();
    expect(f.web.scan).not.toHaveBeenCalled();
    expect(plan.items.map((item) => item.url)).toEqual(
      f.input.sources.map((item) => (item.kind === "url" ? item.url : "")),
    );
    expect(plan.items.map((item) => item.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    const run = await f.run(plan.id);
    expect(run.done, JSON.stringify(f.errors)).toMatchObject({
      status: "completed",
      result: { importBatch: { status: "review_required" } },
    });
    expect(run.view.items.map((item) => item.status)).toEqual([
      "ready",
      "ready",
      "ready",
    ]);
    expect(f.web.scan.mock.calls.map(([input]) => input.url)).toEqual(
      plan.items.map((item) => item.url),
    );
    const preview = run.view.items[0].preview;
    if (!preview) throw new Error("Missing prepared preview");
    const receipt = await f.create(await f.command(preview));
    expect((await f.get(plan.id)).items[0]).toMatchObject({
      status: "imported",
      receipt: { id: receipt.id },
    });
    await f.restart();
    const restored = await f.get(plan.id);
    expect(restored.items.map((item) => item.status)).toEqual([
      "imported",
      "preview_unavailable",
      "preview_unavailable",
    ]);
    expect((await f.prepareBatch()).id).toBe(plan.id);
    await f.settle(await f.invoke("carrot_run_import_batch", run.request));
    expect(f.web.scan).toHaveBeenCalledTimes(3);
    await f.run(plan.id);
    expect(f.web.scan).toHaveBeenCalledTimes(3);
    await f.invoke("carrot_discard_import_batch", {
      id: plan.id,
      confirm: true,
    });
    expect(
      await f.invoke("carrot_get_import_receipt", {
        requestId: receipt.requestId,
      }),
    ).toMatchObject({ id: receipt.id });
    expect(await readFile(f.originals[0])).toEqual(original);
  } finally {
    await f.close();
  }
});

it("preserves later successes around a failed URL and retries only explicitly selected failures", async () => {
  const f = await importBatchFixture();
  try {
    f.web.scan.mockRejectedValueOnce(new Error("Synthetic page unavailable"));
    const plan = await f.prepareBatch();
    const initial = await f.run(plan.id);
    expect(initial.view).toMatchObject({ status: "partial", attemptCount: 3 });
    expect(initial.view.items.map((item) => item.status)).toEqual([
      "failed",
      "ready",
      "ready",
    ]);
    const readyIds = initial.view.items
      .slice(1)
      .map((item) => item.preview?.previewId);
    await f.run(plan.id);
    expect(f.web.scan).toHaveBeenCalledTimes(3);
    const retried = await f.run(plan.id, { retryItemIds: [plan.items[0].id] });
    expect(retried.view).toMatchObject({
      status: "review_required",
      attemptCount: 4,
    });
    expect(
      retried.view.items.slice(1).map((item) => item.preview?.previewId),
    ).toEqual(readyIds);
    expect(f.web.scan.mock.calls.at(-1)?.[0].url).toBe(plan.items[0].url);
    const invalid = await f.run(plan.id, { retryItemIds: [randomUUID()] });
    expect(invalid.done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(f.web.scan).toHaveBeenCalledTimes(4);
  } finally {
    await f.close();
  }
});

it("requires explicit unavailable-preview rescan and never rescans an entry with a retained import receipt", async () => {
  const f = await importBatchFixture(2);
  try {
    const plan = await f.prepareBatch();
    const first = await f.run(plan.id);
    const preview = first.view.items[0].preview;
    if (!preview) throw new Error("Missing preview");
    await f.create(await f.command(preview));
    const base = await f.batchCommand(plan.id);
    expect(
      McpImportBatchRunSchema.safeParse({
        ...base,
        rescanExpiredItemIds: [plan.items[1].id],
      }).success,
    ).toBe(false);
    const live = await f.run(plan.id, {
      rescanExpiredItemIds: [plan.items[1].id],
      acknowledgeDiscardedReceiptRisk: true,
    });
    expect(live.done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    await f.restart();
    const refresh = await f.run(plan.id, {
      rescanExpiredItemIds: plan.items.map((item) => item.id),
      acknowledgeDiscardedReceiptRisk: true,
    });
    expect(refresh.view.items.map((item) => item.status)).toEqual([
      "imported",
      "ready",
    ]);
    expect(f.web.scan).toHaveBeenCalledTimes(3);
    expect(refresh.view.items[1].preview?.previewId).not.toBe(
      first.view.items[1].preview?.previewId,
    );
  } finally {
    await f.close();
  }
});

it("rejects duplicate URLs, credential URLs, foreign plans, stale versions and changed request IDs before browsing", async () => {
  const f = await importBatchFixture(2);
  try {
    for (const urls of [
      ["https://example.com/a#first", "https://example.com/a#second"],
      ["https://user:secret@example.com/a", "https://example.com/b"],
    ]) {
      await expect(
        f.prepareBatch({
          ...f.input,
          requestId: randomUUID(),
          sources: urls.map((url) => ({ kind: "url", url, label: "Review" })),
        }),
      ).rejects.toThrow();
    }
    const plan = await f.prepareBatch();
    await expect(f.get(plan.id, f.auth("other"))).rejects.toThrow();
    await expect(
      f.prepareBatch({ ...f.input, maxAttempts: 29 }),
    ).rejects.toThrow();
    const stale = await f.run(plan.id, { version: plan.version + 1 });
    expect(stale.done).toMatchObject({
      status: "failed",
      error: { code: "revision_conflict" },
    });
    expect(f.web.scan).not.toHaveBeenCalled();
    const distinct = await f.prepareBatch({
      ...f.input,
      requestId: randomUUID(),
      sources: [
        { kind: "url", url: "https://example.com/a?chapter=1", label: "One" },
        { kind: "url", url: "https://example.com/a?chapter=2", label: "Two" },
      ],
    });
    expect(distinct.items).toHaveLength(2);
  } finally {
    await f.close();
  }
});
