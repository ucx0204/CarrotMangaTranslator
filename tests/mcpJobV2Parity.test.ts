import { expect, it } from "vitest";
import { parseMcpStoredJob } from "../src/main/application/mcpJobJournal";
import { snapshotMcpEntry } from "../src/main/application/mcpOperationSnapshot";
import { findOwnedMcpOperation } from "../src/main/application/mcpOperationLookup";
import { jobRecord } from "./mcpJobStoreV2.fixture";

it("rejects an individually valid shape with an inconsistent stored fingerprint", () => {
  expect(() =>
    parseMcpStoredJob({ ...jobRecord(), fingerprint: "0".repeat(16) }),
  ).toThrow("inconsistent");
});

it("preserves the legacy compacted marker only when explicitly reading legacy entries", () => {
  const record = { ...jobRecord(), compacted: true as const };
  expect(
    snapshotMcpEntry({ ...record, controller: new AbortController() }),
  ).toEqual(record);
});

it("the owned lookup still skips unrelated identities and returns no evidence for an absent request", () => {
  const record = jobRecord();
  expect(findOwnedMcpOperation([record], "other", record)).toBeUndefined();
  expect(
    findOwnedMcpOperation([record], record.owner, {
      ...record,
      requestId: "other",
    }),
  ).toBeUndefined();
  expect(findOwnedMcpOperation([], record.owner, record)).toBeUndefined();
});
