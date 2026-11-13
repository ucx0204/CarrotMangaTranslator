import { readFile, writeFile, symlink, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { jobStoreFixture, jobRecord, jobFiles } from "./mcpJobStoreV2.fixture";
import { McpJobStorageFiles } from "../src/main/mcp/mcpJobStorageFiles";
import { MCP_JOB_RETENTION_MS } from "../src/main/application/mcpJobJournal";
import { randomUUID } from "node:crypto";

it("allows an expired request to be reused before stale files are cleaned without deleting the new identity", async () => {
  const f = await jobStoreFixture();
  const record = jobRecord();
  record.startedAt -= MCP_JOB_RETENTION_MS + 100;
  record.finishedAt = record.startedAt;
  await f.store.save(record, null);
  const newer = {
    ...record,
    id: randomUUID(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
  };
  await f.store.save(newer, null);
  const reopened = await f.open();
  await reopened.remove(record.id, 1, Date.now());
  await expect(
    reopened.save({ ...newer, id: randomUUID() }, null),
  ).rejects.toThrow("Duplicate");
  expect(await reopened.read(newer.id)).toEqual(newer);
});

it("preserves a changed receipt during expiry cleanup", async () => {
  const f = await jobStoreFixture();
  const record = jobRecord();
  await f.store.save(record, null);
  const path = (await jobFiles(f.root)).find((p) =>
    p.endsWith(`${record.id}.enc`),
  );
  if (!path) throw new Error("Missing receipt");
  await writeFile(path, "changed");
  await expect(
    f.store.remove(record.id, 1, Date.now() + MCP_JOB_RETENTION_MS),
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("changed");
});

it("resumes interrupted detail cleanup and preserves unknown files", async () => {
  const f = await jobStoreFixture();
  const record = jobRecord({
    blockIds: Array.from({ length: 5000 }, () => "x".repeat(128)),
  });
  const saved = await f.store.save(record, null);
  const original = McpJobStorageFiles.prototype.remove;
  let interrupted = false;
  const spy = vi
    .spyOn(McpJobStorageFiles.prototype, "remove")
    .mockImplementation(function (this: McpJobStorageFiles, path) {
      if (path.endsWith("001.enc") && !interrupted) {
        interrupted = true;
        throw new Error("cleanup interruption");
      }
      return original.call(this, path);
    });
  try {
    await f.store.remove(
      record.id,
      saved.revision,
      Date.now() + MCP_JOB_RETENTION_MS,
    );
  } finally {
    spy.mockRestore();
  }
  expect(interrupted).toBe(true);
  const remaining = (await jobFiles(f.root)).find(
    (p) => p.includes(record.id) && p.endsWith("001.enc"),
  );
  if (!remaining) throw new Error("Missing remaining detail");
  const unknown = join(dirname(remaining), "keep.txt");
  await writeFile(unknown, "preserve");
  await f.store.cleanup(Date.now());
  expect(await readFile(unknown, "utf8")).toBe("preserve");
  expect(await readFile(remaining)).toBeTruthy();
  await unlink(unknown);
  await f.store.cleanup(Date.now() + 10 * 60_000);
  expect((await jobFiles(f.root)).some((p) => p.includes(record.id))).toBe(
    false,
  );
});

it("refuses a junction in detail cleanup without touching its external target", async () => {
  const f = await jobStoreFixture();
  const other = await jobStoreFixture();
  const record = jobRecord();
  await f.store.save(record, null);
  const chunk = (await jobFiles(f.root)).find(
    (p) => p.includes(record.id) && p.endsWith("000.enc"),
  );
  if (!chunk) throw new Error("Missing detail");
  const link = join(dirname(chunk), "unknown-link");
  const target = join(other.root, "user-data");
  await mkdir(target);
  const source = join(target, "original.txt");
  await writeFile(source, "original");
  await symlink(target, link, "junction");
  try {
    await f.store.remove(record.id, 1, Date.now() + MCP_JOB_RETENTION_MS);
    await f.store.cleanup(Date.now());
    expect(await readFile(source, "utf8")).toBe("original");
  } finally {
    // Unlink only the junction/symlink before removing either test directory.
    await unlink(link);
    expect(await readFile(source, "utf8")).toBe("original");
  }
});
