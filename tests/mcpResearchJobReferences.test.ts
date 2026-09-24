import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import {
  parseMcpJobJournal,
  persistedMcpJobResult,
  publicMcpJobResult,
} from "../src/main/application/mcpJobJournal";

function result(retained = true) {
  return {
    pagesChanged: 0,
    proposalExpired: false,
    contextResearch: {
      proposalId: randomUUID(),
      chapterId: "chapter",
      workId: "work",
      revision: "0123456789abcdef",
      source: "app-research",
      changeIds: ["private-change"],
      expiresAt: 1000,
      ...(retained ? { retention: "seven-days" } : {}),
      warnings: [
        "Private research title and source https://example.com/private",
      ],
      queryCount: 2,
      sourceCount: 3,
      tavilyCreditsUsed: 1,
    },
  };
}

it("preserves only bounded lookup references for retained research through repeated serialization", () => {
  const input = result();
  const before = structuredClone(input);
  const saved = persistedMcpJobResult(input);
  expect(saved).toMatchObject({
    proposalExpired: false,
    queryCount: 2,
    sourceCount: 3,
    tavilyCreditsUsed: 1,
    retainedContextProposal: {
      proposalId: input.contextResearch.proposalId,
      chapterId: "chapter",
      workId: "work",
      expiresAt: 1000,
      retention: "seven-days",
      availability: "lookup-required",
    },
  });
  expect(saved).not.toHaveProperty("contextResearch");
  expect(JSON.stringify(saved)).not.toMatch(
    /private|example\.com|warnings|changeIds/,
  );
  expect(persistedMcpJobResult(JSON.parse(JSON.stringify(saved)))).toEqual(
    saved,
  );
  expect(input).toEqual(before);
});

it("computes retained-reference expiry on read, including the exact boundary, without extending it", () => {
  const saved = persistedMcpJobResult(result());
  expect(publicMcpJobResult(saved, 999)?.proposalExpired).toBe(false);
  expect(publicMcpJobResult(saved, 1000)?.proposalExpired).toBe(true);
  expect(
    publicMcpJobResult(saved, 2000)?.retainedContextProposal,
  ).toMatchObject({
    expiresAt: 1000,
    availability: "lookup-required",
  });
  expect(saved?.proposalExpired).toBe(false);
});

it("keeps legacy session research expired after reconstruction rather than inventing persistence", () => {
  const saved = persistedMcpJobResult(result(false));
  expect(saved).toMatchObject({ proposalExpired: true, queryCount: 2 });
  expect(saved).not.toHaveProperty("contextResearch");
  expect(saved).not.toHaveProperty("retainedContextProposal");
  expect(publicMcpJobResult(saved, 1)?.proposalExpired).toBe(true);
  expect(persistedMcpJobResult(undefined)).toBeUndefined();
});

it.each(["edit", "external-research"])(
  "does not manufacture a persisted app-job reference from %s metadata",
  (source) => {
    const input = result();
    input.contextResearch.source = source;
    const saved = persistedMcpJobResult(input);
    expect(saved).toMatchObject({ proposalExpired: true });
    expect(saved).not.toHaveProperty("retainedContextProposal");
  },
);

it("rejects malformed or overbroad lookup references rather than retaining payloads or capability URLs", () => {
  const saved = persistedMcpJobResult(result());
  const reference = saved?.retainedContextProposal;
  if (!reference) throw new Error("Missing test reference");
  for (const patch of [
    { proposalId: "not-a-uuid" },
    { chapterId: "../private" },
    { expiresAt: -1 },
    { retention: "forever" },
    { availability: "available" },
    { url: "https://example.com/capability" },
    { changes: [{ after: "private" }] },
  ]) {
    const value = {
      ...saved,
      retainedContextProposal: { ...reference, ...patch },
    };
    expect(publicMcpJobResult(value, 1)).toBeUndefined();
    expect(() => persistedMcpJobResult(value)).toThrow();
  }
});

it("reconstructs a completed native job reference without rerunning its executor", async () => {
  let stored: unknown = null;
  let now = 100;
  let executions = 0;
  const errors: unknown[] = [];
  const persistence = {
    load: async () => structuredClone(stored),
    save: async (snapshot: unknown) => {
      stored = JSON.parse(JSON.stringify(snapshot));
    },
  };
  const open = () =>
    new McpOperationService(
      (error) => errors.push(error),
      () => now,
      persistence,
    );
  const first = open();
  let next: McpOperationService | undefined;
  const expected = result();
  const requestId = randomUUID();
  const request = {
    owner: "owner",
    requestId,
    kind: "contextResearch",
    parameters: {
      requestId,
      chapterId: "chapter",
      revision: "0123456789abcdef",
      researchTitle: "Explicit work title",
      engine: "tavily",
    },
    assertAuthorized: () => {},
    execute: async () => {
      executions++;
      return expected;
    },
  };
  try {
    const accepted = await first.start(request);
    await first.waitForCompletion(
      accepted.jobId,
      "owner",
      new AbortController().signal,
    );
    await first.close();
    next = open();
    await next.ready();
    const restored = next.status(accepted.jobId, "owner");
    expect(restored).toMatchObject({
      status: "completed",
      persistence: "durable",
    });
    expect(restored.result?.retainedContextProposal?.proposalId).toBe(
      expected.contextResearch.proposalId,
    );
    expect(restored.result?.contextResearch).toBeUndefined();
    expect((await next.start(request)).jobId).toBe(accepted.jobId);
    expect(executions).toBe(1);
    expect(() => next?.status(accepted.jobId, "other")).toThrow();
    const invalid = JSON.parse(JSON.stringify(stored));
    invalid.records[0].result.retainedContextProposal.chapterId =
      "another-chapter";
    expect(() => parseMcpJobJournal(invalid)).toThrow("inconsistent");
    now = 1000;
    expect(next.status(accepted.jobId, "owner").result?.proposalExpired).toBe(
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await first.close();
    await next?.close();
  }
});
