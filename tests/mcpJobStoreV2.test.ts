import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { jobStoreFixture, jobRecord, jobFiles } from "./mcpJobStoreV2.fixture";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import {
  parseMcpJobJournal,
  MCP_JOB_RETENTION_MS,
} from "../src/main/application/mcpJobJournal";
import { McpJobStorageFiles } from "../src/main/mcp/mcpJobStorageFiles";

it("writes bounded encrypted chunks and reads only headers at startup", async () => {
  const f = await jobStoreFixture();
  const record = jobRecord({
    blockIds: Array.from({ length: 5000 }, (_, i) =>
      String(i).padEnd(128, "x"),
    ),
  });
  await f.store.save(record, null);
  const spy = vi.spyOn(McpJobStorageFiles.prototype, "read");
  try {
    const reopened = await f.open();
    expect(spy.mock.calls.some(([path]) => path.includes("/details/"))).toBe(
      false,
    );
    expect(await reopened.read(record.id)).toEqual(record);
    const chunks = (await jobFiles(f.root)).filter((path) =>
      /\d{3}\.enc$/.test(path),
    );
    expect(chunks.length).toBeGreaterThan(2);
    for (const path of chunks) {
      const raw = await readFile(path);
      expect(raw.length).toBeLessThanOrEqual(1024 * 1024);
      expect(raw.toString()).not.toContain(record.requestId);
    }
  } finally {
    spy.mockRestore();
  }
});

it("updates one job without reading or rewriting another job", async () => {
  const f = await jobStoreFixture();
  const a = jobRecord(),
    b = jobRecord();
  await f.store.save(a, null);
  await f.store.save(b, null);
  const reads = vi.spyOn(McpJobStorageFiles.prototype, "read"),
    writes = vi.spyOn(McpJobStorageFiles.prototype, "write");
  try {
    await f.store.save({ ...a, cancellationRequested: true }, 1);
    expect(
      [...reads.mock.calls, ...writes.mock.calls].some(([path]) =>
        path.includes(b.id),
      ),
    ).toBe(false);
    expect(writes.mock.calls.map(([path]) => path)).toHaveLength(1);
    await expect(f.store.save(a, 1)).rejects.toThrow(/revision/);
  } finally {
    reads.mockRestore();
    writes.mockRestore();
  }
});

it("persists cancellation using only the small receipt even after progress changed", async () => {
  const f = await jobStoreFixture();
  const record = {
    ...jobRecord(),
    status: "running" as const,
    finishedAt: undefined,
    result: undefined,
  };
  await f.store.save(record, null);
  const reads = vi.spyOn(McpJobStorageFiles.prototype, "read");
  const writes = vi.spyOn(McpJobStorageFiles.prototype, "write");
  try {
    await f.store.update(record.id, 1, {
      status: "running",
      cancellationRequested: true,
      finishedAt: undefined,
      expiresAt: undefined,
    });
    expect(reads).not.toHaveBeenCalled();
    expect(writes).toHaveBeenCalledOnce();
    expect(writes.mock.calls[0][0]).toContain("/receipts/");
    await expect(
      f.store.update(record.id, 1, {
        status: "running",
        cancellationRequested: true,
      }),
    ).rejects.toThrow("revision");
  } finally {
    reads.mockRestore();
    writes.mockRestore();
  }
  expect(await (await f.open()).read(record.id)).toMatchObject({
    status: "running",
    cancellationRequested: true,
  });
});

it("migrates every legacy identity and blocks the old parser", async () => {
  const f = await jobStoreFixture();
  const record = { ...jobRecord(), compacted: true as const };
  // Fixture intentionally installs a v1 source before constructing its replacement store.
  await f.secure().writeJobJournal({ version: 1, records: [record] });
  const original = await readFile(join(f.root, "mcp-private/jobs.enc"));
  const migrated = await f.open();
  const { compacted: _compacted, ...expected } = record;
  expect(await migrated.read(record.id)).toEqual(expected);
  const root = await f.secure().readJobJournal();
  expect(root).toMatchObject({ version: 2 });
  expect(() => parseMcpJobJournal(root)).toThrow();
  const backups = (await jobFiles(f.root)).filter((path) =>
    path.includes("legacy-jobs"),
  );
  expect(backups).toHaveLength(1);
  expect(await readFile(backups[0])).toEqual(original);
});

it("retains the identity when detail is missing and never repeats its executor", async () => {
  const f = await jobStoreFixture();
  const record = jobRecord();
  await f.store.save(record, null);
  const chunk = (await jobFiles(f.root)).find((path) => /000\.enc$/.test(path));
  if (!chunk) throw new Error("Missing test chunk");
  await unlink(chunk);
  const service = new McpOperationService(
    f.errors,
    Date.now,
    f.secure().jobPersistence(f.errors),
  );
  const execute = vi.fn(async () => ({}));
  try {
    await service.ready();
    await expect(service.status(record.id, record.owner)).rejects.toMatchObject(
      { code: "job_detail_unavailable" },
    );
    await expect(
      service.start({ ...record, assertAuthorized: () => {}, execute }),
    ).rejects.toMatchObject({ code: "job_detail_unavailable" });
    expect(execute).not.toHaveBeenCalled();
    const other = jobRecord();
    const admitted = await service.start({
      ...other,
      execute,
      assertAuthorized: () => {},
    });
    await service.waitForCompletion(
      admitted.jobId,
      other.owner,
      new AbortController().signal,
    );
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    await service.close();
  }
});

it("rejects damaged receipts without resetting the journal", async () => {
  const f = await jobStoreFixture();
  const record = jobRecord();
  await f.store.save(record, null);
  const receipt = (await jobFiles(f.root)).find((path) =>
    path.endsWith(`${record.id}.enc`),
  );
  if (!receipt) throw new Error("Missing test receipt");
  await writeFile(receipt, "damaged");
  await expect(f.open()).rejects.toThrow();
  expect(await readFile(receipt, "utf8")).toBe("damaged");
});

it("removes only expired receipts and their verified detail files", async () => {
  const f = await jobStoreFixture();
  const a = jobRecord(),
    b = jobRecord();
  await f.store.save(a, null);
  await f.store.save(b, null);
  await expect(
    f.store.remove(a.id, 1, (a.finishedAt ?? 0) + MCP_JOB_RETENTION_MS - 1),
  ).rejects.toThrow(/expiry/);
  await f.store.remove(a.id, 1, (a.finishedAt ?? 0) + MCP_JOB_RETENTION_MS);
  expect((await jobFiles(f.root)).some((path) => path.includes(a.id))).toBe(
    false,
  );
  expect(await f.store.read(b.id)).toEqual(b);
});
