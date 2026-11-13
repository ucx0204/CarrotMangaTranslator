import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { jobStoreFixture, jobRecord, jobFiles } from "./mcpJobStoreV2.fixture";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { McpJobStorageFiles } from "../src/main/mcp/mcpJobStorageFiles";

it.each(["detail", "receipt"])(
  "never starts the executor when the initial %s write fails",
  async (stage) => {
    const f = await jobStoreFixture();
    const service = new McpOperationService(f.errors, Date.now, f.store);
    await service.ready();
    const original = McpJobStorageFiles.prototype.write;
    const spy = vi
      .spyOn(McpJobStorageFiles.prototype, "write")
      .mockImplementation(function (
        this: McpJobStorageFiles,
        path,
        bytes,
        max,
      ) {
        if (path.includes(stage === "detail" ? "/details/" : "/receipts/"))
          throw Object.assign(new Error("full"), { code: "ENOSPC" });
        return original.call(this, path, bytes, max);
      });
    const execute = vi.fn(async () => ({}));
    try {
      await expect(
        service.start({ ...jobRecord(), execute, assertAuthorized: () => {} }),
      ).rejects.toThrow("full");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await service.close();
    }
    expect(await (await f.open()).open()).toHaveLength(0);
  },
);

it.each(["detail", "receipt"])(
  "protects the request after effects succeeded but final %s persistence failed",
  async (stage) => {
    const f = await jobStoreFixture();
    const service = new McpOperationService(f.errors, Date.now, f.store);
    const input = jobRecord();
    let fail = false;
    const original = McpJobStorageFiles.prototype.write;
    const spy = vi
      .spyOn(McpJobStorageFiles.prototype, "write")
      .mockImplementation(function (
        this: McpJobStorageFiles,
        path,
        bytes,
        max,
      ) {
        if (
          fail &&
          path.includes(stage === "detail" ? "/details/" : "/receipts/")
        )
          throw new Error("final write fault");
        return original.call(this, path, bytes, max);
      });
    const execute = vi.fn(async () => {
      fail = true;
      return { status: "completed" };
    });
    let id: string;
    try {
      const accepted = await service.start({
        ...input,
        execute,
        assertAuthorized: () => {},
      });
      id = accepted.jobId;
      const result = await service.waitForCompletion(
        id,
        input.owner,
        new AbortController().signal,
      );
      expect(result.status).toBe("interrupted");
      expect(result.error?.code).toBe("journal_unavailable");
    } finally {
      spy.mockRestore();
      await service.close();
    }
    const restored = new McpOperationService(
      f.errors,
      Date.now,
      await f.open(),
    );
    try {
      expect(
        await restored.start({ ...input, execute, assertAuthorized: () => {} }),
      ).toMatchObject({ jobId: id, status: "interrupted" });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await restored.close();
    }
  },
);

it("isolates a corrupt running detail while preserving its request and healthy jobs", async () => {
  const f = await jobStoreFixture();
  const damaged = jobRecord();
  await f.store.save(
    { ...damaged, status: "running", finishedAt: undefined, result: undefined },
    null,
  );
  const healthy = jobRecord();
  await f.store.save(healthy, null);
  const chunk = (await jobFiles(f.root)).find(
    (p) => p.includes(damaged.id) && p.endsWith("000.enc"),
  );
  if (!chunk) throw new Error("Missing fixture chunk");
  await unlink(chunk);
  const service = new McpOperationService(f.errors, Date.now, await f.open());
  const execute = vi.fn(async () => ({}));
  try {
    await service.ready();
    expect((await service.status(healthy.id, healthy.owner)).status).toBe(
      "completed",
    );
    await expect(
      service.start({ ...damaged, execute, assertAuthorized: () => {} }),
    ).rejects.toMatchObject({ code: "job_detail_unavailable" });
    expect(execute).not.toHaveBeenCalled();
    await expect(service.list(healthy.owner, 0, 10)).rejects.toMatchObject({
      code: "job_detail_unavailable",
    });
  } finally {
    await service.close();
  }
});

it("leaves v1 authoritative if migration is interrupted before the root commit", async () => {
  const f = await jobStoreFixture();
  const record = jobRecord();
  await f.secure().writeJobJournal({ version: 1, records: [record] });
  const path = join(f.root, "mcp-private/jobs.enc");
  const source = await readFile(path);
  const secure = f.secure();
  const write = vi
    .spyOn(secure, "writeJobJournal")
    .mockRejectedValue(new Error("power loss"));
  await expect(secure.jobPersistence(f.errors).open()).rejects.toThrow(
    "power loss",
  );
  expect(await readFile(path)).toEqual(source);
  write.mockRestore();
  expect(await (await f.open()).read(record.id)).toEqual(record);
  await writeFile(path, "corrupt-v2-root");
  await expect(f.open()).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("corrupt-v2-root");
});

it("rejects valid encrypted chunks exchanged across jobs", async () => {
  const f = await jobStoreFixture();
  const a = jobRecord(),
    b = jobRecord();
  await f.store.save(a, null);
  await f.store.save(b, null);
  const paths = await jobFiles(f.root);
  const first = paths.find((p) => p.includes(a.id) && p.endsWith("000.enc"));
  const second = paths.find((p) => p.includes(b.id) && p.endsWith("000.enc"));
  if (!first || !second) throw new Error("Missing fixture chunks");
  await writeFile(first, await readFile(second));
  await expect(f.store.read(a.id)).rejects.toMatchObject({
    code: "job_detail_unavailable",
  });
  expect(await f.store.read(b.id)).toEqual(b);
});
