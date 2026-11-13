import { jobPersistenceFixture } from "./mcpJobPersistence.fixture";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  McpOperationService,
  type McpOperationExecutor,
} from "../src/main/application/mcpOperationService";
import {
  MCP_JOB_RETENTION_MS,
  parseMcpJobJournal,
} from "../src/main/application/mcpJobJournal";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it.each(["flux-klein", "lama-manga", "aot-inpainting"] as const)(
  "admits %s through the real tool and preserves its model across durable restart and replay",
  async (localModel) => {
    const { createMcpOperationTools } =
      await import("../src/main/mcp/mcpOperationTools");
    const store = storage();
    const service = new McpOperationService(
      () => {},
      Date.now,
      jobPersistenceFixture(store),
    );
    const execute = vi.fn<McpOperationExecutor>(async () => ({
      pagesChanged: 1,
      blocksErased: 1,
    }));
    const tool = createMcpOperationTools(service, { erase: execute }).find(
      (tool) => tool.name === "carrot_run_page_erasure",
    );
    if (!tool) throw new Error("Missing erasure tool");
    const parameters = { ...input().parameters, localModel };
    const result = await tool.invoke(parameters, {
      principalId: "grant-a",
      assertAuthorized: () => {},
    });
    if (result[0].type !== "text") throw new Error("Missing receipt");
    const receipt = JSON.parse(result[0].text);
    expect((await settled(service, receipt.jobId)).status).toBe("completed");
    expect(execute.mock.calls[0]?.[0]).toEqual(parameters);
    await service.close();
    const restarted = new McpOperationService(
      () => {},
      Date.now,
      jobPersistenceFixture(store),
    );
    try {
      const replay = await restarted.start({
        ...input(),
        kind: "erase",
        parameters,
        requestId: parameters.requestId,
        execute: (operation) => execute(parameters, operation),
      });
      expect(replay.jobId).toBe(receipt.jobId);
      expect(execute).toHaveBeenCalledOnce();
      expect(parseMcpJobJournal(store.snapshot())[0].parameters).toEqual(
        parameters,
      );
    } finally {
      await restarted.close();
    }
  },
);

it("preserves the selected local model when recovering a failed job after restart", async () => {
  const store = storage();
  const request = input();
  const parameters = {
    ...request.parameters,
    localModel: "aot-inpainting" as const,
  };
  const service = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  const receipt = await service.start({
    ...request,
    kind: "erase",
    parameters,
    execute: async () => {
      throw new Error("synthetic engine failure");
    },
  });
  expect((await settled(service, receipt.jobId)).status).toBe("failed");
  await service.close();
  const restarted = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  try {
    await restarted.ready();
    expect(
      await restarted.retryTarget(
        receipt.jobId,
        "grant-a",
        parameters.revision,
      ),
    ).toEqual({
      kind: "erase",
      target: parameters,
    });
  } finally {
    await restarted.close();
  }
});
function input(
  execute = vi.fn(async () => ({ status: "saved", blockIds: ["block"] })),
) {
  const requestId = randomUUID();
  return {
    owner: "grant-a",
    requestId,
    kind: "ocr",
    parameters: {
      chapterId: "chapter",
      pageId: "page",
      revision: "page-v1:0000000000000000",
      requestId,
    },
    assertAuthorized: () => {},
    execute,
  };
}
function storage(initial: unknown = null) {
  let value = structuredClone(initial);
  const save = vi.fn(async (next: unknown) => {
    value = structuredClone(next);
  });
  return {
    load: async () => structuredClone(value),
    save,
    snapshot: () => structuredClone(value),
  };
}
async function settled(service: McpOperationService, id: string) {
  for (let i = 0; i < 200; i++) {
    const result = await service.status(id, "grant-a");
    if (result.status !== "running") return result;
    await tick();
  }
  throw new Error("Job did not settle");
}

it("persists completion and exact request identity across new service instances", async () => {
  const store = storage();
  const request = input();
  const first = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  const receipt = await first.start(request);
  expect((await settled(first, receipt.jobId)).persistence).toBe("durable");
  await first.close();
  const restarted = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  await restarted.ready();
  expect((await restarted.start(request)).jobId).toBe(receipt.jobId);
  expect(request.execute).toHaveBeenCalledOnce();
  expect((await restarted.list("grant-b", 0, 10)).jobs).toEqual([]);
  await expect(
    async () =>
      await restarted.retryTarget(
        receipt.jobId,
        "grant-a",
        request.parameters.revision,
      ),
  ).rejects.toThrow(/Only failed/);
  const listed = await restarted.list("grant-a", 0, 10);
  expect(listed.total).toBe(1);
  const listedResult = listed.jobs[0].result;
  if (!listedResult) throw new Error("Missing saved result");
  listedResult.blockIds = [];
  expect(
    (await restarted.status(receipt.jobId, "grant-a")).result?.blockIds,
  ).toEqual(["block"]);
  await expect(
    restarted.start({
      ...request,
      parameters: { ...request.parameters, pageId: "other" },
    }),
  ).rejects.toThrow(/requestId/);
  await restarted.close();
});

it("does not execute or acknowledge a new job until its durable receipt has committed", async () => {
  const store = storage();
  let release!: () => void;
  let entered!: () => void;
  const pendingWrite = new Promise<void>((r) => {
    release = r;
  });
  const writing = new Promise<void>((r) => {
    entered = r;
  });
  const originalSave = store.save;
  let first = true;
  store.save = vi.fn(async (value) => {
    if (first) {
      first = false;
      entered();
      await pendingWrite;
    }
    await originalSave(value);
  });
  const service = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  const request = input();
  const start = service.start(request);
  await writing;
  const duplicate = service.start(request);
  expect(request.execute).not.toHaveBeenCalled();
  release();
  const a = await start;
  expect((await duplicate).jobId).toBe(a.jobId);
  await settled(service, a.jobId);
  expect(request.execute).toHaveBeenCalledOnce();
  await service.close();
});

it("marks crash-time running records interrupted without automatically rerunning the executor", async () => {
  const store = storage();
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const request = input(
    vi.fn(async () => {
      await blocked;
      return { status: "saved", blockIds: ["block"] };
    }),
  );
  const original = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  const receipt = await original.start(request);
  const recoveredStore = storage(store.snapshot());
  const recovered = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(recoveredStore),
  );
  try {
    await recovered.ready();
    const job = await recovered.status(receipt.jobId, "grant-a");
    expect(job.status).toBe("interrupted");
    expect(job.error?.message).toMatch(/Inspect the saved page/);
    expect((await recovered.start(request)).jobId).toBe(receipt.jobId);
    expect(request.execute).toHaveBeenCalledOnce();
    expect(
      await recovered.retryTarget(
        receipt.jobId,
        "grant-a",
        request.parameters.revision,
      ),
    ).toEqual({ kind: "ocr", target: request.parameters });
    await expect(
      async () =>
        await recovered.retryTarget(
          receipt.jobId,
          "grant-b",
          request.parameters.revision,
        ),
    ).rejects.toThrow(/not found/);
    await expect(
      async () =>
        await recovered.retryTarget(
          receipt.jobId,
          "grant-a",
          "page-v1:1111111111111111",
        ),
    ).rejects.toThrow(/original target revision/);
  } finally {
    release();
    await original.close();
    await recovered.close();
  }
});

it("does not persist temporary output links, raw image contents or private paths", async () => {
  const store = storage();
  const request = {
    ...input(),
    kind: "exportPng",
    execute: async () => ({
      kind: "rendered-page-png",
      url: "https://carrot.test/mcp-artifacts/secret.png",
      path: "C:/private",
      image: "sensitive",
      bytes: 42,
    }),
  };
  const first = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  const receipt = await first.start(request);
  expect((await settled(first, receipt.jobId)).result).toEqual({
    kind: "rendered-page-png",
    bytes: 42,
  });
  await first.close();
  const text = JSON.stringify(store.snapshot());
  for (const secret of ["secret.png", "C:/private", "sensitive"])
    expect(text).not.toContain(secret);
  const restored = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  await restored.ready();
  expect((await restored.status(receipt.jobId, "grant-a")).result).toEqual({
    kind: "rendered-page-png",
    bytes: 42,
    artifactExpired: true,
  });
  await restored.close();
});

it("rejects initial journal write failure before any executor side effect", async () => {
  const store = storage();
  store.save.mockRejectedValue(new Error("disk unavailable"));
  const service = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  const request = input();
  await expect(service.start(request)).rejects.toThrow(/disk unavailable/);
  expect(request.execute).not.toHaveBeenCalled();
  expect((await service.list("grant-a", 0, 10)).total).toBe(0);
  await expect(service.start(input())).rejects.toThrow(
    /storage is unavailable/,
  );
  await service.close();
});

it("reports uncertain final persistence without pretending committed page work was rolled back", async () => {
  const errors: unknown[] = [];
  const store = storage();
  let committed = false;
  const service = new McpOperationService(
    (e) => errors.push(e),
    Date.now,
    jobPersistenceFixture(store),
  );
  const receipt = await service.start({
    ...input(),
    execute: async () => {
      committed = true;
      store.save.mockRejectedValue(new Error("final write unavailable"));
      return { status: "saved", blockIds: ["kept"] };
    },
  });
  const result = await settled(service, receipt.jobId);
  expect(committed).toBe(true);
  expect(result.status).toBe("interrupted");
  expect(result.error?.code).toBe("journal_unavailable");
  expect(result.result?.blockIds).toEqual(["kept"]);
  expect(errors).toHaveLength(1);
  const disk = parseMcpJobJournal(store.snapshot());
  expect(disk[0].status).toBe("running");
  await expect(service.start(input())).rejects.toThrow(
    /storage is unavailable/,
  );
  await service.close();
});

it("does not erase or replace corrupt journals during failed startup", async () => {
  const original = { version: 1, records: [{ id: "bad" }] };
  const store = storage(original);
  const service = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  await expect(service.ready()).rejects.toThrow();
  await expect(service.start(input())).rejects.toThrow();
  expect(store.save).not.toHaveBeenCalled();
  expect(store.snapshot()).toEqual(original);
  await expect(service.close()).rejects.toThrow();
});

it("validates record identity and removes only expired settled receipts on restart", async () => {
  let now = 1000;
  const store = storage();
  const first = new McpOperationService(
    () => {},
    () => now,
    jobPersistenceFixture(store),
  );
  const request = input();
  const receipt = await first.start(request);
  await settled(first, receipt.jobId);
  await first.close();
  const records = parseMcpJobJournal(store.snapshot());
  expect(() =>
    parseMcpJobJournal({ version: 1, records: [...records, ...records] }),
  ).toThrow(/duplicate/);
  expect(() =>
    parseMcpJobJournal({
      version: 1,
      records: [{ ...records[0], fingerprint: "1111111111111111" }],
    }),
  ).toThrow(/inconsistent/);
  now += MCP_JOB_RETENTION_MS;
  const restored = new McpOperationService(
    () => {},
    () => now,
    jobPersistenceFixture(store),
  );
  await restored.ready();
  expect((await restored.list("grant-a", 0, 10)).total).toBe(0);
  await restored.close();
});

it("blocks future admission when malformed final receipt data cannot be serialized", async () => {
  const store = storage();
  const service = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  const receipt = await service.start({
    ...input(),
    execute: async () => ({ blocksErased: -1 }),
  });
  expect((await settled(service, receipt.jobId)).error?.code).toBe(
    "journal_unavailable",
  );
  await expect(service.start(input())).rejects.toThrow(
    /storage is unavailable/,
  );
  await service.close();
});
it("does not label an explicitly failed app result completed", async () => {
  const store = storage();
  const service = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(store),
  );
  const receipt = await service.start({
    ...input(),
    execute: async () => ({ status: "failed" }),
  });
  expect((await settled(service, receipt.jobId)).status).toBe("failed");
  await service.close();
});
