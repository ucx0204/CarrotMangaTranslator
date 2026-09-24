import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  McpSyncOutputSchema,
  McpOutputSyncReceiptSchema,
} from "../src/shared/mcpOutputSync";
import { McpOutputSyncJobResultSchema } from "../src/shared/mcpOutputSyncJob";
import { mcpOutputSyncJobResult } from "../src/main/application/mcpOutputSyncJobPolicy";
import {
  parseMcpJobJournal,
  publicMcpJobResult,
  persistedMcpJobResult,
} from "../src/main/application/mcpJobJournal";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import {
  mcpJobReceiptOutput,
  mcpJobFileOutput,
} from "../src/main/mcp/mcpJobOutputSchema";

function fixture(
  status:
    | "completed"
    | "partial"
    | "failed"
    | "cancelled"
    | "interrupted" = "completed",
) {
  const jobId = randomUUID();
  const input = McpSyncOutputSchema.parse({
    chapterId: "chapter",
    connectionId: "connection",
    pageIds: ["first", "second"],
    selectionSnapshot: "1".repeat(16),
    destinationSnapshot: "2".repeat(16),
    sourceSnapshot: "3".repeat(16),
    requestId: randomUUID(),
    confirm: true,
    acknowledgePartialPublication: true,
    acknowledgeSavedTextMirror: true,
  });
  // Public receipt contract fixture only; native publication admission/effect
  // consistency belongs to the existing encrypted-repository tests.
  const receipt = McpOutputSyncReceiptSchema.parse({
    id: randomUUID(),
    requestId: input.requestId,
    jobId,
    chapterId: input.chapterId,
    connectionId: input.connectionId,
    pageIds: input.pageIds,
    createdAt: 100,
    expiresAt: 100 + 7 * 24 * 60 * 60_000,
    status,
    historical: false,
    sourceChecked: false,
    files: [],
    publishedBytes: 0,
    reportedPublishedBytes: 0,
    publicationUnconfirmed: 0,
    errorCode: null,
    metadata: "pending",
    mirror: "pending",
  });
  const result = mcpOutputSyncJobResult({ input, receipt, jobId });
  const record = {
    id: jobId,
    owner: "owner",
    requestId: input.requestId,
    kind: "outputSync",
    parameters: input,
    fingerprint: hashStableValue(["outputSync", input]),
    status,
    progress: { phase: "done" },
    result,
    startedAt: 100,
    finishedAt: 101,
    cancellationRequested: status === "cancelled",
  };
  return { input, receipt, result, record, jobId };
}
function publicReceipt(f: ReturnType<typeof fixture>) {
  return {
    jobId: f.jobId,
    requestId: f.input.requestId,
    kind: "outputSync",
    target: f.input,
    persistence: "durable",
    status: f.record.status,
    progress: f.record.progress,
    result: f.result,
    startedAt: 100,
    finishedAt: 101,
    cancellationRequested: f.record.cancellationRequested,
  };
}

it.each([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
] as const)(
  "retains truthful %s sync lookup metadata with no destination files or capabilities",
  (status) => {
    const f = fixture(status);
    expect(f.result).toEqual({
      kind: "output-sync",
      status,
      outputSync: {
        receiptId: f.receipt.id,
        requestId: f.input.requestId,
        jobId: f.jobId,
        chapterId: f.input.chapterId,
        connectionId: f.input.connectionId,
        pageIds: f.input.pageIds,
        requestFingerprint: hashStableValue(f.input),
        retention: "seven-days",
        availability: "lookup-required",
      },
    });
    const value = {
      ...f.result,
      url: "https://private.example/file",
      relativePath: "private/result.png",
      files: f.receipt.files,
    };
    expect(persistedMcpJobResult(value)).toEqual(f.result);
    expect(publicMcpJobResult(value, 100)).toEqual(f.result);
    expect(
      parseMcpJobJournal({ version: 1, records: [f.record] })[0].result,
    ).toEqual(f.result);
    expect(mcpJobReceiptOutput.safeParse(publicReceipt(f)).success).toBe(true);
    expect(
      mcpJobFileOutput.safeParse({ jobId: f.jobId, ...f.result }).success,
    ).toBe(false);
    expect(JSON.stringify(f.result)).not.toMatch(
      /relativePath|"files"|"url"|publishedBytes|sourceChecked/,
    );
  },
);

it("requires an already terminal receipt for this exact job and request", () => {
  const f = fixture();
  for (const patch of [
    { jobId: randomUUID() },
    { requestId: randomUUID() },
    { status: "running" },
    { chapterId: "other" },
    { connectionId: "other" },
    { pageIds: [...f.input.pageIds].reverse() },
    { pageIds: f.input.pageIds.slice(0, 1) },
  ]) {
    const receipt = McpOutputSyncReceiptSchema.parse({
      ...f.receipt,
      ...patch,
    });
    expect(() =>
      mcpOutputSyncJobResult({ input: f.input, receipt, jobId: f.jobId }),
    ).toThrow();
  }
  expect(() => mcpOutputSyncJobResult({ ...f, jobId: randomUUID() })).toThrow();
});

it("binds journal and public receipts to exact selection, destination and source snapshots", () => {
  const f = fixture();
  for (const patch of [
    { chapterId: "other" },
    { connectionId: "other" },
    { pageIds: [...f.input.pageIds].reverse() },
    { selectionSnapshot: "4".repeat(16) },
    { destinationSnapshot: "4".repeat(16) },
    { sourceSnapshot: "4".repeat(16) },
    { requestId: randomUUID() },
    { confirm: false },
    { acknowledgePartialPublication: false },
    { acknowledgeSavedTextMirror: false },
    { relativePath: "private/result.png" },
  ]) {
    const parameters = { ...f.input, ...patch };
    expect(() =>
      parseMcpJobJournal({
        version: 1,
        records: [
          {
            ...f.record,
            parameters,
            fingerprint: hashStableValue(["outputSync", parameters]),
          },
        ],
      }),
    ).toThrow();
    expect(
      mcpJobReceiptOutput.safeParse({ ...publicReceipt(f), target: parameters })
        .success,
    ).toBe(false);
  }
});

it("rejects forged references and prevents sync metadata from becoming an artifact or another command result", () => {
  const f = fixture();
  for (const patch of [
    { jobId: randomUUID() },
    { requestId: randomUUID() },
    { chapterId: "other" },
    { connectionId: "other" },
    { pageIds: [...f.input.pageIds].reverse() },
    { requestFingerprint: "4".repeat(16) },
    { availability: "available" },
    { relativePath: "private/result.png" },
  ]) {
    const result = {
      ...f.result,
      outputSync: { ...f.result.outputSync, ...patch },
    };
    expect(() =>
      parseMcpJobJournal({ version: 1, records: [{ ...f.record, result }] }),
    ).toThrow();
    expect(
      mcpJobReceiptOutput.safeParse({ ...publicReceipt(f), result }).success,
    ).toBe(false);
  }
  for (const patch of [
    { kind: "rendered-pages-zip" },
    { retainedOutputId: randomUUID() },
    { bytes: 128 },
    { mimeType: "image/png" },
  ]) {
    const result = { ...f.result, ...patch };
    expect(McpOutputSyncJobResultSchema.safeParse(result).success).toBe(false);
    expect(() =>
      parseMcpJobJournal({ version: 1, records: [{ ...f.record, result }] }),
    ).toThrow();
  }
  const parameters = {
    chapterId: "chapter",
    pageId: "first",
    revision: "page-v1:" + "1".repeat(16),
    requestId: f.input.requestId,
  };
  expect(() =>
    parseMcpJobJournal({
      version: 1,
      records: [
        {
          ...f.record,
          kind: "exportPng",
          parameters,
          fingerprint: hashStableValue(["exportPng", parameters]),
        },
      ],
    }),
  ).toThrow();
  expect(
    mcpJobReceiptOutput.safeParse({
      ...publicReceipt(f),
      kind: "exportPng",
      target: parameters,
    }).success,
  ).toBe(false);
});

it.each(["completed", "partial"] as const)(
  "preserves a %s native receipt when the outer job's journal commit is interrupted",
  (status) => {
    const f = fixture(status);
    const error = {
      code: "journal_unavailable",
      message: "Final operation receipt could not be saved.",
    };
    const [record] = parseMcpJobJournal({
      version: 1,
      records: [{ ...f.record, status: "interrupted", error }],
    });
    expect(record.status).toBe("interrupted");
    expect(record.result).toEqual(f.result);
    expect(
      mcpJobReceiptOutput.safeParse({
        ...publicReceipt(f),
        status: "interrupted",
        error,
      }).success,
    ).toBe(true);
  },
);

it.each([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
] as const)(
  "replays %s sync jobs after restart without republishing or retrying automatically",
  async (status) => {
    const f = fixture(status);
    let saved: unknown = null;
    const errors: unknown[] = [];
    const persistence = {
      load: async () => structuredClone(saved),
      save: async (value: unknown) => {
        saved = JSON.parse(JSON.stringify(value));
      },
    };
    const open = () =>
      new McpOperationService(
        (error) => errors.push(error),
        () => 100,
        persistence,
      );
    const first = open();
    let restored: McpOperationService | undefined;
    const execute = vi.fn(async (job: { id: string }) =>
      mcpOutputSyncJobResult({
        input: f.input,
        receipt: { ...f.receipt, jobId: job.id },
        jobId: job.id,
      }),
    );
    const request = {
      owner: "owner",
      requestId: f.input.requestId,
      kind: "outputSync",
      parameters: f.input,
      assertAuthorized: () => {},
      execute,
    };
    try {
      const accepted = await first.start(request);
      const completed = await first.waitForCompletion(
        accepted.jobId,
        "owner",
        new AbortController().signal,
      );
      expect(completed.status).toBe(status);
      await first.close();
      restored = open();
      await restored.ready();
      expect(restored.status(accepted.jobId, "owner")).toMatchObject({
        status,
        result: {
          kind: "output-sync",
          status,
          outputSync: { receiptId: f.receipt.id, jobId: accepted.jobId },
        },
      });
      expect((await restored.start(request)).jobId).toBe(accepted.jobId);
      expect(execute).toHaveBeenCalledOnce();
      expect(() => restored?.file(accepted.jobId, "owner")).toThrow();
      expect(() => restored?.outputMetadata(accepted.jobId, "owner")).toThrow();
      expect(() =>
        restored?.retryTarget(
          accepted.jobId,
          "owner",
          "page-v1:" + "1".repeat(16),
        ),
      ).toThrow();
      expect(errors).toEqual([]);
    } finally {
      await first.close();
      await restored?.close();
    }
  },
);
