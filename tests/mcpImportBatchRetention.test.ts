import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { importBatchFixture } from "./mcpImportBatch.fixture";
import { chapterDiscoveryFixture } from "./mcpChapterDiscovery.fixture";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { mcpImportBatchOutputs } from "../src/shared/mcpImportBatch";
import { validMcpJobReferences } from "../src/main/application/mcpJobReferencePolicy";

it("replays the retained run even after the separate job journal is lost", async () => {
  const f = await importBatchFixture(1);
  try {
    const plan = await f.prepareBatch();
    const result = await f.run(plan.id);
    await f.current().operations.close();
    await f.persistence.save({ version: 1, records: [] });
    await f.restart();
    expect(f.current().operations.list("import-owner", 0, 25).total).toBe(0);
    const replayed = await f.settle(
      await f.invoke("carrot_run_import_batch", result.request),
    );
    expect(replayed).toMatchObject({
      status: "completed",
      result: { importBatch: { id: plan.id } },
    });
    expect(f.web.scan).toHaveBeenCalledOnce();
    const reference = replayed.result?.importBatch;
    if (!reference) throw new Error("Missing batch reference");
    const valid = {
      kind: "importBatchScan",
      requestId: result.request.requestId,
      parameters: result.request,
      result: { importBatch: reference },
    };
    expect(validMcpJobReferences(valid)).toBe(true);
    for (const changed of [
      { ...valid, kind: "ocr" },
      { ...valid, parameters: {} },
      { ...valid, result: { importBatch: { ...reference, id: randomUUID() } } },
      {
        ...valid,
        result: {
          importBatch: { ...reference, version: result.request.version },
        },
      },
    ])
      expect(validMcpJobReferences(changed)).toBe(false);
  } finally {
    await f.close();
  }
});

it("keeps an uncertain scan interrupted after checkpoint failure and requires an explicit retry", async () => {
  const f = await importBatchFixture(1);
  const seal = f.codec.seal.bind(f.codec);
  let rejectReady = true;
  f.codec.seal = async (value) => {
    if (
      rejectReady &&
      value &&
      typeof value === "object" &&
      "items" in value &&
      Array.isArray(value.items) &&
      value.items.some(
        (item) =>
          item &&
          typeof item === "object" &&
          "attempts" in item &&
          Array.isArray(item.attempts) &&
          item.attempts.some(
            (attempt: { status: string }) => attempt.status === "ready",
          ),
      )
    )
      throw new Error("Synthetic disk publication failure");
    return seal(value);
  };
  try {
    const plan = await f.prepareBatch();
    const first = await f.run(plan.id);
    expect(first.done.status).toBe("failed");
    expect(first.view.items[0].status).toBe("interrupted");
    rejectReady = false;
    await f.restart();
    expect((await f.get(plan.id)).items[0].status).toBe("interrupted");
    await f.run(plan.id);
    expect(f.web.scan).toHaveBeenCalledOnce();
    const retry = await f.run(plan.id, { retryItemIds: [plan.items[0].id] });
    expect(retry.view.items[0].status).toBe("ready");
    expect(f.web.scan).toHaveBeenCalledTimes(2);
  } finally {
    rejectReady = false;
    await f.close();
  }
});

it("rejects stale checkpoints, altered fixed sources, generic disposal and exact-expiry lookup", async () => {
  const f = await importBatchFixture(1);
  try {
    const { McpImportBatchRepository } =
      await import("../src/main/mcp/mcpImportBatchRepository");
    const { McpRetentionCatalog } =
      await import("../src/main/mcp/mcpRetentionCatalog");
    const repository = new McpImportBatchRepository(f.storage);
    const plan = await f.prepareBatch();
    const record = await repository.load("import-owner", plan.id);
    const changed = structuredClone(record);
    changed.version++;
    changed.items[0].target.url = "https://example.com/unreviewed";
    changed.sourceFingerprint = hashStableValue(
      changed.items.map((item) => item.target),
    );
    await expect(
      repository.save(changed, record.version, () => {}),
    ).rejects.toThrow("transition");
    await expect(
      repository.save({ ...record, version: 1 }, 99, () => {}),
    ).rejects.toThrow("changed");
    const catalog = new McpRetentionCatalog(
      f.storage,
      new AbortController().signal,
      false,
    );
    await expect(
      catalog.discard("import-owner", plan.id, () => {}),
    ).rejects.toThrow("carrot_discard_import_batch");
    f.clock(plan.expiresAt);
    await expect(f.get(plan.id)).rejects.toThrow();
    expect(f.web.scan).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("pins only selected owned discovery links and retains the plan after independent discovery disposal", async () => {
  const f = await chapterDiscoveryFixture(3);
  try {
    const discovery = await f.discover();
    const reviewed = await f.get(discovery.id);
    const input = {
      requestId: randomUUID(),
      sources: [reviewed.links[2], reviewed.links[0]].map((link) => ({
        kind: "discovered",
        id: discovery.id,
        snapshot: discovery.snapshot,
        linkId: link.id,
        label: link.label,
      })),
    };
    const plan = mcpImportBatchOutputs.carrot_prepare_import_batch.parse(
      await f.invoke("carrot_prepare_import_batch", input),
    );
    expect(plan.items.map((item) => item.url)).toEqual([
      reviewed.links[2].url,
      reviewed.links[0].url,
    ]);
    expect(f.web.scan).not.toHaveBeenCalled();
    await expect(
      f.invoke(
        "carrot_prepare_import_batch",
        { ...input, requestId: randomUUID() },
        f.auth("other"),
      ),
    ).rejects.toThrow();
    const { McpRetentionCatalog } =
      await import("../src/main/mcp/mcpRetentionCatalog");
    await new McpRetentionCatalog(
      f.storage,
      new AbortController().signal,
      false,
    ).discard("import-owner", discovery.id, () => {});
    expect(await f.invoke("carrot_prepare_import_batch", input)).toMatchObject({
      id: plan.id,
    });
    await f.settle(
      await f.invoke("carrot_run_import_batch", {
        id: plan.id,
        version: plan.version,
        requestId: randomUUID(),
        allowNetwork: true,
      }),
    );
    expect(f.web.scan.mock.calls.map(([request]) => request.url)).toEqual(
      plan.items.map((item) => item.url),
    );
    expect(f.web.discoverChapters).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
