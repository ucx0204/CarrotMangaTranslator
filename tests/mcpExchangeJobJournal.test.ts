import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  parseMcpJobJournal,
  persistedMcpJobResult,
  publicMcpJobResult,
} from "../src/main/application/mcpJobJournal";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import {
  mcpOperationFile,
  mcpOperationOutputMetadata,
} from "../src/main/application/mcpOperationOutputs";
import {
  mcpJobFileOutput,
  mcpJobReceiptOutput,
} from "../src/main/mcp/mcpJobOutputSchema";
import { exchangeJobData, textImportJobData } from "./mcpExchangeJob.fixture";

it.each(["txt", "csv", "tsv", "context"] as const)(
  "persists exact %s exchange metadata without capabilities or raw payload",
  (format) => {
    const f = exchangeJobData(format);
    const input = {
      ...f.result,
      sourcePath: "C:/private/source.txt",
      rawText: "private source payload",
    };
    const expected = {
      kind: "exchange-file",
      exchange: f.binding,
      mimeType: f.result.mimeType,
      bytes: f.result.bytes,
      sha256: f.result.sha256,
      retainedOutputId: f.result.retainedOutputId,
      performed: ["serialize", "export"],
    };
    expect(persistedMcpJobResult(input)).toEqual(expected);
    expect(publicMcpJobResult(input, 100)).toEqual(expected);
    const [saved] = parseMcpJobJournal({ version: 1, records: [f.record] });
    expect(saved.parameters).toEqual(f.target);
    expect(saved.result).toEqual(expected);
    expect(JSON.stringify(saved)).not.toMatch(
      /C:\/private|private source payload|mcp-artifacts|"url"|filename/,
    );
    const receipt = {
      target: saved.parameters,
      persistence: "durable",
      jobId: saved.id,
      requestId: saved.requestId,
      kind: saved.kind,
      status: saved.status,
      cancellationRequested: false,
      progress: saved.progress,
      result: saved.result,
      startedAt: saved.startedAt,
      finishedAt: saved.finishedAt,
    };
    expect(mcpJobReceiptOutput.safeParse(receipt).success).toBe(true);
  },
);

it("binds text files to page order, revisions, serializer settings and saved metadata", () => {
  const f = exchangeJobData();
  if (f.binding.kind !== "text") throw new Error("Expected text binding");
  const binding = f.binding;
  const variants = [
    { workId: "other" },
    { chapterId: "other" },
    { snapshot: "fedcba9876543210" },
    { direction: "ltr" },
    { pages: [...binding.pages].reverse() },
    { pages: binding.pages.slice(0, 1) },
    {
      pages: binding.pages.map((page) => ({
        ...page,
        revision: "page-v1:fedcba9876543210",
      })),
    },
    { options: { format: "csv", includeBom: false } },
  ];
  for (const patch of variants) {
    const parameters = { ...f.target, binding: { ...binding, ...patch } };
    const targetChanged = {
      ...f.record,
      parameters,
      fingerprint: hashStableValue([f.record.kind, parameters]),
    };
    const resultChanged = {
      ...f.record,
      result: { ...f.record.result, exchange: { ...binding, ...patch } },
    };
    for (const record of [targetChanged, resultChanged])
      expect(() =>
        parseMcpJobJournal({ version: 1, records: [record] }),
      ).toThrow();
  }
});

it("binds context files to one chapter, explicit scope and native source snapshot", () => {
  const f = exchangeJobData("context");
  for (const patch of [
    { workId: "other" },
    { chapterId: "other" },
    { scope: "guide-and-memory" },
    { sourceSnapshot: "fedcba9876543210" },
    { requestId: randomUUID() },
  ]) {
    const parameters = { ...f.target, ...patch };
    const record = {
      ...f.record,
      parameters,
      fingerprint: hashStableValue([f.record.kind, parameters]),
    };
    expect(() =>
      parseMcpJobJournal({ version: 1, records: [record] }),
    ).toThrow();
  }
  expect(f.binding).not.toHaveProperty("pages");
  expect(() =>
    parseMcpJobJournal({ version: 1, records: [f.record] }),
  ).not.toThrow();
});

it("rejects wrong exchange kinds, MIME, source binding fields and cross-command references", () => {
  const f = exchangeJobData();
  for (const result of [
    { ...f.record.result, mimeType: "application/json" },
    { ...f.record.result, exchange: undefined },
    { ...f.record.result, bytes: 0 },
    { ...f.record.result, bytes: 4 * 1024 * 1024 + 1 },
    {
      ...f.record.result,
      exchange: { ...f.binding, sourcePath: "C:/private/file.csv" },
    },
    { ...f.record.result, kind: "rendered-page-png" },
    { ...f.record.result, batchId: randomUUID() },
  ])
    expect(() =>
      parseMcpJobJournal({ version: 1, records: [{ ...f.record, result }] }),
    ).toThrow();
  const parameters = {
    chapterId: "chapter",
    pageId: "first",
    revision: "page-v1:0123456789abcdef",
    requestId: f.record.requestId,
  };
  const kind = "exportPng";
  expect(() =>
    parseMcpJobJournal({
      version: 1,
      records: [
        {
          ...f.record,
          kind,
          parameters,
          fingerprint: hashStableValue([kind, parameters]),
        },
      ],
    }),
  ).toThrow();
});

it("preserves truthful text import outcomes and exact batch/action replay identity", () => {
  const f = textImportJobData();
  expect(publicMcpJobResult(f.result, 100)).toEqual(f.result);
  expect(
    parseMcpJobJournal({ version: 1, records: [f.record] })[0].result,
  ).toEqual(f.result);
  for (const patch of [
    { batchId: randomUUID() },
    { status: "partial" },
    { outcome: { ...f.result.outcome, activeRequestId: randomUUID() } },
    { outcome: { ...f.result.outcome, batchId: randomUUID() } },
    { outcome: { ...f.result.outcome, direction: "undo" } },
    { outcome: { ...f.result.outcome, status: "running" } },
    { input: { ...f.result.input, rawText: "private uploaded text" } },
  ])
    expect(() =>
      parseMcpJobJournal({
        version: 1,
        records: [{ ...f.record, result: { ...f.result, ...patch } }],
      }),
    ).toThrow();
  const partial = {
    ...f.result,
    status: "partial",
    completionCheck: { status: "failed", code: "revision_conflict" },
  };
  expect(publicMcpJobResult(partial, 100)).toEqual(partial);
  expect(
    persistedMcpJobResult({ ...partial, rawText: "private uploaded text" }),
  ).toEqual(partial);
  const parameters = { ...f.target, batchId: randomUUID() };
  expect(() =>
    parseMcpJobJournal({
      version: 1,
      records: [
        {
          ...f.record,
          parameters,
          fingerprint: hashStableValue([f.record.kind, parameters]),
        },
      ],
    }),
  ).toThrow();
});

it.each(["csv", "context"] as const)(
  "projects only a completed and exactly bound %s file",
  (format) => {
    const f = exchangeJobData(format);
    const entry = {
      ...f.record,
      settled: true,
      result: {
        ...f.result,
        sourcePath: "C:/private/source",
        rawText: "private payload",
      },
    };
    expect(mcpOperationFile(entry)).toEqual(f.result);
    const output = { jobId: f.record.id, ...f.result };
    expect(mcpJobFileOutput.safeParse(output).success).toBe(true);
    for (const patch of [
      { mimeType: "image/png" },
      { filename: "private-title.csv" },
      {
        filename:
          format === "csv" ? "carrot-context.json" : "carrot-review.csv",
      },
      { sourcePath: "C:/private/source" },
    ])
      expect(mcpJobFileOutput.safeParse({ ...output, ...patch }).success).toBe(
        false,
      );
    for (const status of ["running", "partial", "failed", "cancelled"])
      expect(() => mcpOperationFile({ ...entry, status })).toThrow();
    expect(() => mcpOperationFile(entry, "first")).toThrow();
    expect(() =>
      mcpOperationFile({ ...entry, requestId: randomUUID() }),
    ).toThrow();
    expect(() =>
      mcpOperationFile({ ...entry, result: { ...f.result, bytes: 0 } }),
    ).toThrow();
    const historical = { ...entry, result: f.record.result };
    expect(() => mcpOperationFile(historical)).toThrow();
    expect(mcpOperationOutputMetadata(historical)).toEqual({
      artifact: {
        mimeType: f.result.mimeType,
        bytes: f.result.bytes,
        sha256: f.result.sha256,
        retainedOutputId: f.result.retainedOutputId,
      },
    });
  },
);

it.each(["export", "import"] as const)(
  "restores %s receipts and replays without executing or accessing expired session input",
  async (mode) => {
    const f = mode === "export" ? exchangeJobData() : textImportJobData();
    let stored: unknown = null;
    const errors: unknown[] = [];
    const persistence = {
      load: async () => structuredClone(stored),
      save: async (value: unknown) => {
        stored = JSON.parse(JSON.stringify(value));
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
    const execute = vi.fn(async () => f.result);
    const request = {
      owner: "owner",
      requestId: f.target.requestId,
      kind: f.record.kind,
      parameters: f.target,
      assertAuthorized: () => {},
      execute,
    };
    try {
      const accepted = await first.start(request);
      await first.waitForCompletion(
        accepted.jobId,
        "owner",
        new AbortController().signal,
      );
      expect(first.status(accepted.jobId, "owner").status).toBe("completed");
      if (mode === "export")
        expect(first.outputMetadata(accepted.jobId, "owner")?.url).toMatch(
          /mcp-artifacts/,
        );
      await first.close();
      restored = open();
      await restored.ready();
      expect(restored.status(accepted.jobId, "owner")).toMatchObject({
        status: "completed",
        target: f.target,
        result: { kind: f.result.kind },
      });
      expect(JSON.stringify(stored)).not.toMatch(/mcp-artifacts|"url"/);
      expect(() => restored?.status(accepted.jobId, "other-owner")).toThrow();
      if (mode === "export") {
        expect(restored.outputMetadata(accepted.jobId, "owner")).toMatchObject({
          artifact: { bytes: 128 },
        });
        expect(
          restored.outputMetadata(accepted.jobId, "owner"),
        ).not.toHaveProperty("url");
        expect(() => restored?.file(accepted.jobId, "owner")).toThrow();
      } else
        expect(() =>
          restored?.outputMetadata(accepted.jobId, "owner"),
        ).toThrow();
      expect((await restored.start(request)).jobId).toBe(accepted.jobId);
      expect(execute).toHaveBeenCalledOnce();
      expect(errors).toEqual([]);
    } finally {
      await first.close();
      await restored?.close();
    }
  },
);
