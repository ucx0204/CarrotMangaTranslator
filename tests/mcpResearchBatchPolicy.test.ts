import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  McpResearchBatchPrepareSchema,
  McpResearchWorkSchema,
} from "../src/shared/mcpResearchBatch";
import {
  McpResearchBatchRecordSchema,
  researchBatchView,
  researchHolds,
  rememberResearchAction,
  assertResearchBatchVersion,
} from "../src/main/application/mcpResearchBatchPolicy";

function record() {
  const target = McpResearchWorkSchema.parse({
    workId: "work",
    chapterId: "chapter",
    revision: "a".repeat(16),
    referenceSnapshot: "b".repeat(16),
    researchTitle: "Confirmed title",
    engine: "tavily",
    titleConfirmed: true,
    allowSpoilers: true,
  });
  const input = McpResearchBatchPrepareSchema.parse({
    requestId: randomUUID(),
    works: [target],
    maxAttempts: 3,
  });
  return McpResearchBatchRecordSchema.parse({
    format: 1,
    id: randomUUID(),
    owner: "owner",
    version: 0,
    createdAt: 1,
    expiresAt: 1000,
    input,
    inputFingerprint: hashStableValue(input),
    settingsFingerprint: "c".repeat(16),
    status: "prepared",
    requests: [],
    works: [{ target, status: "pending", attempts: [] }],
  });
}
it("checks checkpoint target identity, original input hash, sequence and terminal consistency", () => {
  const value = record();
  const variants = [
    { ...value, expiresAt: 0 },
    { ...value, inputFingerprint: "d".repeat(16) },
    { ...value, works: [] },
    { ...value, status: "completed" },
    {
      ...value,
      requests: [
        { requestId: value.id, fingerprint: value.settingsFingerprint },
        { requestId: value.id, fingerprint: value.settingsFingerprint },
      ],
    },
  ];
  for (const variant of variants)
    expect(McpResearchBatchRecordSchema.safeParse(variant).success).toBe(false);
  for (const key of [
    "workId",
    "chapterId",
    "revision",
    "referenceSnapshot",
    "engine",
  ] as const) {
    const copy = structuredClone(value);
    Object.assign(copy.works[0].target, {
      [key]: key === "engine" ? "codex-web" : "other",
    });
    expect(McpResearchBatchRecordSchema.safeParse(copy).success).toBe(false);
  }
  expect(assertResearchBatchVersion(value, 0)).toBeUndefined();
  expect(() => assertResearchBatchVersion(value, 1)).toThrow("current version");
});

it("validates attempt provenance without allowing a completed result to precede another attempt", () => {
  const value = record();
  const attempt = {
    requestId: randomUUID(),
    jobId: randomUUID(),
    status: "proposed" as const,
    proposalId: randomUUID(),
    usage: { queryCount: 1, sourceCount: 1, tavilyCreditsUsed: 1 },
    errorCode: null,
  };
  value.works[0].attempts = [attempt];
  value.works[0].status = "proposed";
  value.status = "completed";
  expect(McpResearchBatchRecordSchema.safeParse(value).success).toBe(true);
  const bad = structuredClone(value);
  bad.works[0].attempts.push({ ...attempt, requestId: randomUUID() });
  expect(McpResearchBatchRecordSchema.safeParse(bad).success).toBe(false);
  for (const patch of [
    { proposalId: null },
    { usage: null },
    { status: "no_changes" },
    { status: "failed" },
  ]) {
    const copy = structuredClone(value);
    Object.assign(copy.works[0].attempts[0], patch);
    expect(McpResearchBatchRecordSchema.safeParse(copy).success).toBe(false);
  }
  value.works[0].target.titleConfirmed = false;
  expect(McpResearchBatchRecordSchema.safeParse(value).success).toBe(false);
});

it("projects interruption and active finalization separately without private snapshots or model settings", () => {
  const value = record();
  expect(
    researchHolds({
      ...value.works[0].target,
      titleConfirmed: false,
      allowSpoilers: false,
    }),
  ).toEqual(["title_unconfirmed", "spoiler_scope"]);
  value.status = "running";
  expect(researchBatchView(value).status).toBe("interrupted");
  const controller = new AbortController();
  controller.abort();
  value.status = "failed";
  expect(researchBatchView(value, { pause: true, controller })).toMatchObject({
    status: "running",
    pauseRequested: true,
    cancellationRequested: true,
  });
  expect(JSON.stringify(researchBatchView(value))).not.toMatch(
    /referenceSnapshot|settingsFingerprint|inputFingerprint|"owner"/,
  );
});

it("retains exact historical actions but rejects request reuse and unbounded action history", () => {
  const value = record();
  const requestId = randomUUID();
  expect(rememberResearchAction(value, requestId, "d".repeat(16))).toBe(false);
  expect(rememberResearchAction(value, requestId, "d".repeat(16))).toBe(true);
  expect(() =>
    rememberResearchAction(value, requestId, "e".repeat(16)),
  ).toThrow("another action");
  while (value.requests.length < 64)
    rememberResearchAction(value, randomUUID(), "d".repeat(16));
  expect(() =>
    rememberResearchAction(value, randomUUID(), "d".repeat(16)),
  ).toThrow("full");
});
