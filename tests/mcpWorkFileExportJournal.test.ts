import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  parseMcpJobJournal,
  persistedMcpJobResult,
  publicMcpJobResult,
} from "../src/main/application/mcpJobJournal";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { workFileJobData } from "./mcpWorkFileJob.fixture";

it("persists the reviewed working-file identity without source paths or session capabilities", () => {
  const f = workFileJobData();
  const input = {
    ...f.result,
    sourcePath: "C:/private/source/page.png",
    outputPath: "C:/private/output/work.mgtshare",
    password: "private-secret",
  };
  const before = structuredClone(input);
  const expected = {
    kind: f.result.kind,
    bytes: f.result.bytes,
    sha256: f.result.sha256,
    retainedOutputId: f.result.retainedOutputId,
    workFileExport: f.metadata,
    performed: f.result.performed,
  };
  const saved = persistedMcpJobResult(input);
  expect(saved).toEqual(expected);
  expect(publicMcpJobResult(input, 100)).toEqual(expected);
  expect(persistedMcpJobResult(JSON.parse(JSON.stringify(saved)))).toEqual(
    saved,
  );
  const records = parseMcpJobJournal({
    version: 1,
    records: [{ ...f.record, result: saved }],
  });
  expect(records[0].parameters).toEqual(f.target);
  expect(records[0].result).toEqual(expected);
  expect(JSON.stringify(records)).not.toMatch(
    /C:\/private|private-secret|mcp-artifacts|"url"|sourcePath|outputPath/,
  );
  expect(input).toEqual(before);
});

it("binds persisted results to both snapshots, work identity and exact chapter order", () => {
  const f = workFileJobData();
  for (const patch of [
    { workId: "different-work" },
    { snapshot: "fedcba9876543210" },
    { sourceSnapshot: "fedcba9876543210" },
    { chapterIds: [...f.target.chapterIds].reverse() },
    { chapterIds: [f.target.chapterIds[0]] },
    { chapterIds: [f.target.chapterIds[0], "different-chapter"] },
  ]) {
    const parameters = { ...f.target, ...patch };
    const changedTarget = {
      ...f.record,
      parameters,
      fingerprint: hashStableValue(["workFileExport", parameters]),
    };
    const changedResult = {
      ...f.record,
      result: {
        ...f.record.result,
        workFileExport: { ...f.metadata, ...patch },
      },
    };
    for (const record of [changedTarget, changedResult])
      expect(() =>
        parseMcpJobJournal({ version: 1, records: [record] }),
      ).toThrow(/inconsistent/);
  }
});

it("rejects a page job relabeled as working-file export and a working-file result attached to a page job", () => {
  const f = workFileJobData();
  const parameters = {
    chapterId: "chapter-first",
    pageId: "page",
    revision: "page-v1:0123456789abcdef",
    requestId: f.target.requestId,
  };
  for (const kind of ["workFileExport", "exportPng"])
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
    ).toThrow(/inconsistent/);
});

it("requires explicit source binding and acknowledgements in restored targets", () => {
  const f = workFileJobData();
  for (const patch of [
    { sourceSnapshot: undefined },
    { acknowledgeOriginalImages: false },
    { acknowledgeV1Limitations: false },
    { sourcePath: "C:/private/source/page.png" },
    { requestId: randomUUID() },
  ]) {
    const parameters = { ...f.target, ...patch };
    expect(() =>
      parseMcpJobJournal({
        version: 1,
        records: [
          {
            ...f.record,
            parameters,
            fingerprint: hashStableValue(["workFileExport", parameters]),
          },
        ],
      }),
    ).toThrow();
  }
});

it("restores an expired working-file receipt without reviving its URL or executing the export again", async () => {
  const f = workFileJobData();
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
  const execute = vi.fn(async () => ({
    ...f.result,
    sourcePath: "C:/private/source/page.png",
  }));
  const request = {
    owner: "owner",
    requestId: f.target.requestId,
    kind: "workFileExport",
    parameters: f.target,
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
    expect(completed.status).toBe("completed");
    expect(first.file(accepted.jobId, "owner").url).toBe(f.result.url);
    expect(JSON.stringify(stored)).not.toMatch(
      /C:\/private|mcp-artifacts|"url"/,
    );
    await first.close();
    restored = open();
    await restored.ready();
    const receipt = restored.status(accepted.jobId, "owner");
    expect(receipt).toMatchObject({
      kind: "workFileExport",
      status: "completed",
      persistence: "durable",
      target: f.target,
      result: {
        kind: "native-work-file",
        artifactExpired: true,
        workFileExport: f.metadata,
        retainedOutputId: f.result.retainedOutputId,
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /C:\/private|mcp-artifacts|"url"/,
    );
    expect(() => restored?.file(accepted.jobId, "owner")).toThrow();
    expect(() => restored?.status(accepted.jobId, "other-owner")).toThrow();
    expect((await restored.start(request)).jobId).toBe(accepted.jobId);
    expect(execute).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  } finally {
    await first.close();
    await restored?.close();
  }
});
