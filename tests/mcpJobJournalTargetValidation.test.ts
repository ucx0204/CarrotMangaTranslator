import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  parseMcpJobJournal,
  type McpStoredJob,
} from "../src/main/application/mcpJobJournal";

const requestId = randomUUID();
const pageTarget = {
  chapterId: "chapter",
  pageId: "page",
  revision: "page-v1:0000000000000000",
  requestId,
};
const researchTarget = {
  chapterId: "chapter",
  revision: "0000000000000000",
  researchTitle: "Synthetic fixture",
  engine: "tavily" as const,
  requestId,
};

function record(
  kind: McpStoredJob["kind"],
  parameters: McpStoredJob["parameters"],
): McpStoredJob {
  return {
    id: randomUUID(),
    owner: "grant-a",
    requestId: parameters.requestId,
    kind,
    parameters,
    fingerprint: hashStableValue([kind, parameters]),
    status: "completed",
    progress: { phase: "done" },
    startedAt: 1000,
    finishedAt: 1001,
    cancellationRequested: false,
  };
}

it.each(["ocr", "blockOcr", "blockTranslation", "erase", "exportPng"] as const)(
  "rejects a research-shaped target mislabeled as %s even with a matching fingerprint",
  (kind) => {
    const job = record(kind, researchTarget);
    expect(() => parseMcpJobJournal({ version: 1, records: [job] })).toThrow(
      /inconsistent/,
    );
  },
);

it("rejects a page-shaped target mislabeled as research", () => {
  const job = record("contextResearch", pageTarget);
  expect(() => parseMcpJobJournal({ version: 1, records: [job] })).toThrow(
    /inconsistent/,
  );
});

it("retains valid mixed page and research receipts without changing identity", () => {
  const jobs = [
    record("ocr", pageTarget),
    record("contextResearch", { ...researchTarget, requestId: randomUUID() }),
    record("blockOcr", {
      ...pageTarget,
      blockId: "block",
      requestId: randomUUID(),
    }),
    record("blockTranslation", {
      ...pageTarget,
      blockId: "block",
      contextMode: "saved",
      requestId: randomUUID(),
    }),
  ];
  expect(parseMcpJobJournal({ version: 1, records: jobs })).toEqual(jobs);
});

it.each([0, 2, 3, 4, "1", null])(
  "rejects unsupported journal version %j rather than treating it as a v1 receipt",
  (version) => {
    expect(() =>
      parseMcpJobJournal({ version, records: [record("ocr", pageTarget)] }),
    ).toThrow();
  },
);

it.each(["blockOcr", "blockTranslation"] as const)(
  "requires a selected block for persisted %s jobs",
  (kind) => {
    expect(() =>
      parseMcpJobJournal({ version: 1, records: [record(kind, pageTarget)] }),
    ).toThrow(/inconsistent/);
  },
);

it.each(["ocr", "erase", "exportPng"] as const)(
  "rejects translation context options on persisted %s jobs",
  (kind) => {
    const parameters = { ...pageTarget, contextMode: "saved" as const };
    expect(() =>
      parseMcpJobJournal({ version: 1, records: [record(kind, parameters)] }),
    ).toThrow(/inconsistent/);
  },
);
