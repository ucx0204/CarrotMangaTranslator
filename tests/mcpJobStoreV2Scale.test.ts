import { stat, mkdir, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { jobStoreFixture, jobRecord, jobFiles } from "./mcpJobStoreV2.fixture";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { McpJobStorageFiles } from "../src/main/mcp/mcpJobStorageFiles";

it.skipIf(process.env.MGT_MCP_JOB_SOAK !== "1")(
  "admits and replays after 10000 encrypted records exceeding 64 MiB",
  async () => {
    const f = await jobStoreFixture();
    const began = performance.now();
    const sample = jobRecord({
      blockIds: Array.from({ length: 90 }, (_, i) => String(i).padEnd(64, "x")),
    });
    await f.store.save(sample, null);
    for (let i = 1; i < 10000; i++)
      await f.store.save(jobRecord(sample.result), null);
    const writtenMs = performance.now() - began;
    const paths = await jobFiles(f.root);
    let bytes = 0;
    for (const path of paths) bytes += (await stat(path)).size;
    expect(bytes).toBeGreaterThan(64 * 1024 * 1024);
    const read = vi.spyOn(McpJobStorageFiles.prototype, "read");
    const start = performance.now();
    const store = await f.open();
    const indexMs = performance.now() - start;
    expect(read.mock.calls.some(([path]) => path.includes("/details/"))).toBe(
      false,
    );
    read.mockRestore();
    const service = new McpOperationService(f.errors, Date.now, store);
    try {
      await service.ready();
      const execute = vi.fn(async () => ({ status: "completed" }));
      expect(
        (
          await service.start({
            ...sample,
            assertAuthorized: () => {},
            execute,
          })
        ).jobId,
      ).toBe(sample.id);
      expect(execute).not.toHaveBeenCalled();
      const input = jobRecord();
      const fresh = await service.start({
        ...input,
        assertAuthorized: () => {},
        execute,
      });
      expect(
        (
          await service.waitForCompletion(
            fresh.jobId,
            input.owner,
            new AbortController().signal,
          )
        ).status,
      ).toBe("completed");
      expect((await service.list(input.owner, 0, 1)).total).toBe(10001);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await service.close();
    }
    const report = {
      records: 10000,
      bytes,
      files: paths.length,
      writtenMs,
      indexMs,
      heapUsed: process.memoryUsage().heapUsed,
      rss: process.memoryUsage().rss,
    };
    await mkdir(".tmp", { recursive: true });
    await writeFile(
      ".tmp/issue176-job-scale.json",
      JSON.stringify(report, null, 2),
    );
  },
  900_000,
);
