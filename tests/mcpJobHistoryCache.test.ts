import { expect, it, vi } from "vitest";
import { McpOperationHistory } from "../src/main/application/mcpOperationHistory";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { jobPersistenceFixture } from "./mcpJobPersistence.fixture";
import { jobRecord } from "./mcpJobStoreV2.fixture";

it("bounds cached plaintext to 32 MiB and reads only the requested list window", async () => {
  const result = {
    blockIds: Array.from({ length: 5000 }, (_, i) =>
      String(i).padEnd(128, "x"),
    ),
  };
  const records = Array.from({ length: 60 }, () => jobRecord(result));
  const store = jobPersistenceFixture({
    load: async () => ({ version: 1, records }),
    save: async () => {},
  });
  const service = new McpOperationService(() => {}, Date.now, store);
  const read = vi.spyOn(store, "read");
  try {
    await service.ready();
    expect(read).not.toHaveBeenCalled();
    const page = await service.list("owner", 10, 2);
    expect(read.mock.calls.map(([id]) => id).sort()).toEqual(
      page.jobs.map((j) => j.jobId).sort(),
    );
    for (const record of records) await service.status(record.id, record.owner);
    read.mockClear();
    // Each record is ~640 KiB; all sixty cannot fit. The most recent fifty do.
    for (const record of records.slice(-50))
      await service.status(record.id, record.owner);
    expect(read).not.toHaveBeenCalled();
    await service.status(records[0].id, records[0].owner);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    await service.close();
  }
});

it("does not apply restart recovery to a current-session result after cache eviction", async () => {
  const records = new Map<string, ReturnType<typeof jobRecord>>();
  const persistence = jobPersistenceFixture({
    load: async () => null,
    save: async (value) => {
      const snapshot = value as { records: ReturnType<typeof jobRecord>[] };
      for (const record of snapshot.records) records.set(record.id, record);
    },
  });
  const history = new McpOperationHistory(persistence, Date.now);
  await history.open();
  const record = jobRecord();
  await history.save(record);
  const large = {
    blockIds: Array.from({ length: 5000 }, () => "x".repeat(128)),
  };
  // This is a session-only result. It must not turn into artifactExpired on eviction.
  const entry = await history.get(record.id, record.owner);
  entry.result = {
    kind: "rendered-page-png",
    url: "https://session.invalid/output",
  };
  history.settle(entry, record);
  for (let i = 0; i < 55; i++) await history.save(jobRecord(large));
  expect((await history.get(record.id, record.owner)).result).toEqual(
    entry.result,
  );
  expect(records.get(record.id)?.result).toEqual(record.result);
}, 30_000);
