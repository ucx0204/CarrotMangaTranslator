import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  parseMcpJobJournal,
  persistedMcpJobResult,
} from "../src/main/application/mcpJobJournal";

it("restores a ZIP receipt without restoring its expired file link", () => {
  const requestId = randomUUID();
  const parameters = {
    requestId,
    sourceJobId: randomUUID(),
    allowPartial: false,
  };
  const record = {
    id: randomUUID(),
    owner: "fixture-owner",
    requestId,
    kind: "exportZip",
    parameters,
    fingerprint: hashStableValue(["exportZip", parameters]),
    status: "completed",
    progress: { phase: "completed" },
    result: persistedMcpJobResult({
      kind: "rendered-pages-zip",
      sourceJobId: parameters.sourceJobId,
      pageCount: 2,
      partialOutput: false,
      url: "https://private.invalid/mcp-artifacts/expired/pages.zip",
    }),
    startedAt: 1,
    finishedAt: 2,
    cancellationRequested: false,
  };
  const restored = parseMcpJobJournal({ version: 1, records: [record] });
  expect(restored[0].parameters).toEqual(parameters);
  expect(restored[0].result).toEqual({
    kind: "rendered-pages-zip",
    sourceJobId: parameters.sourceJobId,
    pageCount: 2,
    partialOutput: false,
  });
  expect(JSON.stringify(restored)).not.toContain("mcp-artifacts");
  const wrong = {
    chapterId: "chapter",
    pageId: "page",
    revision: "page-v1:0123456789abcdef",
    requestId,
  };
  expect(() =>
    parseMcpJobJournal({
      version: 1,
      records: [
        {
          ...record,
          parameters: wrong,
          fingerprint: hashStableValue(["exportZip", wrong]),
        },
      ],
    }),
  ).toThrow(/inconsistent/);
});
