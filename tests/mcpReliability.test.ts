import { jobPersistenceFixture } from "./mcpJobPersistence.fixture";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { McpPageBatchService } from "../src/main/application/mcpPageBatchService";
import { translationBatchPolicy } from "../src/main/application/mcpTranslationBatchPolicy";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { parseMcpStoredJob } from "../src/main/application/mcpJobJournal";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { mcpToolError } from "../src/main/mcp/mcpToolResult";
import { handleMcpMessage } from "../src/main/mcp/mcpProtocol";
import { createMcpReadTools } from "../src/main/mcp/mcpReadTools";
import { McpLibraryReadService } from "../src/main/application/mcpLibraryReadService";
import { McpInvalidParams } from "../src/main/mcp/mcpArguments";

const origin = "https://reliability.example.test";
const secret = "p".repeat(43);
const register = {
  redirect_uris: ["https://chatgpt.com/connector/oauth/reliability"],
  token_endpoint_auth_method: "none",
};

it("keeps approved connections valid through registration flooding and restart", () => {
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
  });
  const token = createMcpTestGrant(origin, secret)(provider, "carrot.read");
  for (let i = 0; i < 130; i++) provider.register(register);
  expect(provider.accepts(`Bearer ${token}`)).toBe(true);
  const snapshot = provider.snapshot();
  expect(snapshot.clients).toHaveLength(65);
  const restored = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
  });
  restored.restore(snapshot);
  expect(() => restored.register(register)).not.toThrow();
  expect(restored.accepts(`Bearer ${token}`)).toBe(true);
  expect(() =>
    createMcpTestGrant(origin, secret)(restored, "carrot.read"),
  ).not.toThrow();
});

it("reclaims revoked grants and clients instead of exhausting approval history", () => {
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
  });
  const grant = createMcpTestGrant(origin, secret);
  for (let i = 0; i < 270; i++) {
    const token = grant(provider, "carrot.read");
    const connection = provider.connectionIdFor(`Bearer ${token}`);
    if (!connection) throw new Error("Missing approved connection");
    provider.revokeConnection(connection);
    expect(provider.accepts(`Bearer ${token}`)).toBe(false);
  }
  expect(() => grant(provider, "carrot.read")).not.toThrow();
  expect(provider.snapshot().grants).toHaveLength(1);
});

it("reserves preview capacity before expensive planning and prevents concurrent duplicate generation", async () => {
  const f = translationBatchFixture();
  const plan = vi.fn(translationBatchPolicy.plan);
  const service = new McpPageBatchService(f.ports, {
    ...translationBatchPolicy,
    plan,
  });
  try {
    for (let i = 0; i < 31; i++)
      await service.preview(f.owner, f.request(), f.guard);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    plan.mockImplementationOnce(async (...args) => {
      await barrier;
      return translationBatchPolicy.plan(...args);
    });
    const input = f.request();
    const pending = service.preview(f.owner, input, f.guard);
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(32));
    const duplicate = service.preview(f.owner, input, f.guard);
    await expect(
      service.preview(f.owner, f.request(), f.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    release();
    const receipt = await pending;
    expect((await duplicate).batchId).toBe(receipt.batchId);
    expect((await service.preview(f.owner, input, f.guard)).batchId).toBe(
      receipt.batchId,
    );
    await expect(
      service.preview(f.owner, f.request(), f.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    expect(plan).toHaveBeenCalledTimes(32);
  } finally {
    await service.close();
    await f.service.close();
  }
});

it("admits beyond 512 completed jobs while preserving durable replay and workflow receipts", async () => {
  let journal: unknown = null;
  const execute = vi.fn(async () => ({ status: "saved", blockIds: ["a"] }));
  const storage = {
    load: async () => journal,
    save: async (value: unknown) => {
      journal = structuredClone(value);
    },
  };
  const service = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(storage),
  );
  const requestId = randomUUID();
  const first = {
    owner: "a",
    kind: "ocr",
    requestId,
    parameters: {
      requestId,
      chapterId: "c",
      pageId: "p",
      revision: "page-v1:0000000000000000",
    },
    assertAuthorized: () => {},
    execute,
  };
  const receipt = await service.start(first);
  await service.waitForCompletion(
    receipt.jobId,
    "a",
    new AbortController().signal,
  );
  for (let i = 0; i < 513; i++) {
    const id = randomUUID();
    const next = await service.start({
      ...first,
      owner: "b",
      requestId: id,
      parameters: { ...first.parameters, requestId: id },
    });
    await service.waitForCompletion(
      next.jobId,
      "b",
      new AbortController().signal,
    );
  }
  expect((await service.start(first)).jobId).toBe(receipt.jobId);
  expect(execute).toHaveBeenCalledTimes(514);
  const found = await service.findOwnedOperation("a", {
    requestId,
    kind: "ocr",
    fingerprint: hashStableValue(["ocr", first.parameters]),
  });
  expect(found?.jobId).toBe(receipt.jobId);
  await service.close();
  const saved = (journal as { records: unknown[] }).records.map(
    parseMcpStoredJob,
  );
  expect(saved).toHaveLength(514);
  expect(saved.filter((record) => record.compacted)).toHaveLength(0);
  const restarted = new McpOperationService(
    () => {},
    Date.now,
    jobPersistenceFixture(storage),
  );
  try {
    expect((await restarted.start(first)).jobId).toBe(receipt.jobId);
    expect(execute).toHaveBeenCalledTimes(514);
    await expect(
      restarted.start({
        ...first,
        parameters: { ...first.parameters, pageId: "other" },
      }),
    ).rejects.toThrow(/requestId/);
  } finally {
    await restarted.close();
  }
}, 60_000);

it("reports native busy as retryable without leaking internal messages", () => {
  const result = mcpToolError(
    Object.assign(new Error("C:/private/secret"), {
      code: "APP_ACTIVITY_BUSY",
    }),
  );
  expect(result.structuredContent).toMatchObject({
    error: "editor_busy",
    retryable: true,
  });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("sanitizes malformed diagnostic metadata without echoing arbitrary inputs", () => {
  const error = new McpInvalidParams([
    { expected: { secret: "PRIVATE" }, minimum: "PRIVATE", maximum: "PRIVATE" },
  ]);
  expect(error.issues).toEqual([{ field: "arguments", code: "invalid_value" }]);
  expect(JSON.stringify(mcpToolError(error))).not.toContain("PRIVATE");
});

it("releases failed preview reservations and waits for in-flight preparation on shutdown", async () => {
  const f = translationBatchFixture();
  const plan = vi.fn(translationBatchPolicy.plan);
  const service = new McpPageBatchService(f.ports, {
    ...translationBatchPolicy,
    plan,
  });
  let release = () => {};
  try {
    const input = f.request();
    plan.mockRejectedValueOnce(new Error("transient model failure"));
    await expect(service.preview(f.owner, input, f.guard)).rejects.toThrow(
      "transient model failure",
    );
    expect(
      (await service.preview(f.owner, input, f.guard)).batchId,
    ).toBeTruthy();
    await expect(
      service.preview(f.owner, { ...input, reason: "changed intent" }, f.guard),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    plan.mockImplementationOnce(async (...args) => {
      const oversized = await translationBatchPolicy.plan(...args);
      oversized.pages[0].changes[0].sourceText = "x".repeat(4 * 1024 * 1024);
      return oversized;
    });
    await expect(
      service.preview(f.owner, f.request(), f.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    plan.mockImplementationOnce(async (...args) => {
      await pending;
      return translationBatchPolicy.plan(...args);
    });
    const preview = service.preview(f.owner, f.request(), f.guard);
    const rejected = expect(preview).rejects.toMatchObject({
      code: "access_denied",
    });
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(4));
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    await rejected;
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    release();
    await service.close();
    await f.service.close();
  }
});

it("returns model-visible field corrections for invalid arguments", async () => {
  const service = new McpLibraryReadService({
    listLibrary: vi.fn(),
    openChapter: vi.fn(),
  });
  const reply = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "carrot_list_works", arguments: { limit: 101 } },
    },
    createMcpReadTools(service),
    vi.fn(),
  );
  expect(reply.body).toMatchObject({
    result: {
      isError: true,
      structuredContent: {
        error: "invalid_arguments",
        issues: [{ field: "limit", maximum: 100 }],
      },
    },
  });
});

it("rejects cumulative preview bytes after planning and releases the reservation", async () => {
  const f = translationBatchFixture();
  const plan = vi.fn(
    async (...args: Parameters<typeof translationBatchPolicy.plan>) => {
      const result = await translationBatchPolicy.plan(...args);
      result.pages[0].changes[0].sourceText = "x".repeat(3_900_000);
      return result;
    },
  );
  const service = new McpPageBatchService(f.ports, {
    ...translationBatchPolicy,
    plan,
  });
  try {
    for (let index = 0; index < 8; index++)
      await service.preview(f.owner, f.request(), f.guard);
    const input = f.request();
    await expect(
      service.preview(f.owner, input, f.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    plan.mockImplementationOnce(async (...args) =>
      translationBatchPolicy.plan(...args),
    );
    expect(
      (await service.preview(f.owner, input, f.guard)).batchId,
    ).toBeTruthy();
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await f.service.close();
  }
});

it("rejects preparation when the owning app session already ended", async () => {
  const f = translationBatchFixture();
  const plan = vi.fn(translationBatchPolicy.plan);
  const service = new McpPageBatchService(
    f.ports,
    { ...translationBatchPolicy, plan },
    Date.now,
    AbortSignal.abort(),
  );
  try {
    await expect(
      service.preview(f.owner, f.request(), f.guard),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(plan).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await f.service.close();
  }
});

it("keeps action replay scoped to its owner when two owners reuse a request ID", async () => {
  const f = translationBatchFixture();
  const requestId = randomUUID();
  const signal = new AbortController().signal;
  try {
    const first = await f.service.preview(f.owner, f.request(), f.guard);
    f.service.start(
      f.owner,
      { batchId: first.batchId, requestId },
      "apply",
      f.guard,
    );
    await f.service.waitForAction(f.owner, first.batchId, requestId, signal);
    const input = f.request();
    for (const page of input.pages)
      for (const edit of page.edits) edit.translatedText += " second owner";
    const second = await f.service.preview("other-owner", input, f.guard);
    expect(
      f.service.start(
        "other-owner",
        { batchId: second.batchId, requestId },
        "apply",
        f.guard,
      ),
    ).toMatchObject({ status: "accepted", batchId: second.batchId });
    expect(
      (
        await f.service.waitForAction(
          "other-owner",
          second.batchId,
          requestId,
          signal,
        )
      ).status,
    ).toBe("completed");
    expect(
      f.service.start(
        f.owner,
        { batchId: first.batchId, requestId },
        "apply",
        f.guard,
      ),
    ).toMatchObject({ status: "already_started", batchId: first.batchId });
  } finally {
    await f.service.close();
  }
});
