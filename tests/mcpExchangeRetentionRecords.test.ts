import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  RetainedOutputSchema,
  RetentionIndexSchema,
} from "../src/main/mcp/mcpRetentionRecords";
import { MCP_EXCHANGE_BYTES } from "../src/shared/mcpExchangeFiles";

const target = {
  workId: "work",
  chapterId: "chapter",
  pageId: "page",
  revision: `page-v1:${"a".repeat(16)}`,
  files: [
    {
      path: "/private/source.png",
      sha256: "a".repeat(64),
      bytes: 17,
      asset: null,
    },
  ],
};
const base = {
  version: 1,
  id: randomUUID(),
  owner: "owner",
  sha256: "b".repeat(64),
  bytes: 17,
};
const context = {
  kind: "context",
  workId: "work",
  chapterId: "chapter",
  scope: "guide",
  snapshot: "c".repeat(16),
};
const text = {
  kind: "text",
  workId: "work",
  chapterId: "chapter",
  direction: "ltr",
  snapshot: "d".repeat(16),
  pages: [{ pageId: "page", revision: target.revision }],
  options: { format: "csv", includeBom: true },
};
const entry = (mimeType: string, pageCount: number) => ({
  version: 1,
  entries: [
    {
      id: base.id,
      owner: "owner",
      kind: "output",
      operation: "carrot_export_text_file",
      requestId: null,
      createdAt: 1,
      expiresAt: 2,
      bytes: 100,
      pageCount,
      mimeType,
      sha256: base.sha256,
    },
  ],
});

it("keeps legacy raster records and their page floor unchanged", () => {
  const legacy = { ...base, mimeType: "image/png", targets: [target] };
  expect(RetainedOutputSchema.parse(legacy)).toEqual(legacy);
  expect(
    RetainedOutputSchema.safeParse({ ...legacy, targets: [] }).success,
  ).toBe(false);
  expect(
    RetainedOutputSchema.safeParse({ ...legacy, exchangeBinding: context })
      .success,
  ).toBe(false);
  expect(RetentionIndexSchema.safeParse(entry("image/png", 0)).success).toBe(
    false,
  );
  expect(RetentionIndexSchema.safeParse(entry("image/png", 1)).success).toBe(
    true,
  );
  expect(RetentionIndexSchema.safeParse(entry("image/png", 51)).success).toBe(
    false,
  );
});

it("requires the exact exchange MIME, bounded byte count and source binding without image targets", () => {
  for (const [mimeType, exchangeBinding] of [
    ["text/csv", text],
    ["application/json", context],
  ] as const) {
    const record = { ...base, mimeType, exchangeBinding, targets: [] };
    expect(RetainedOutputSchema.safeParse(record).success).toBe(true);
    expect(
      RetainedOutputSchema.safeParse({ ...record, exchangeBinding: undefined })
        .success,
    ).toBe(false);
    expect(
      RetainedOutputSchema.safeParse({ ...record, targets: [target] }).success,
    ).toBe(false);
    expect(
      RetainedOutputSchema.safeParse({ ...record, bytes: 0 }).success,
    ).toBe(false);
    expect(
      RetainedOutputSchema.safeParse({
        ...record,
        bytes: MCP_EXCHANGE_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      RetainedOutputSchema.safeParse({ ...record, mimeType: "text/plain" })
        .success,
    ).toBe(false);
    expect(
      RetainedOutputSchema.safeParse({
        ...record,
        exchangeBinding: { ...exchangeBinding, path: "/private/source" },
      }).success,
    ).toBe(false);
  }
});

it("admits context outputs at zero pages and text outputs at their existing one-to-fifty page floor", () => {
  expect(
    RetentionIndexSchema.safeParse(entry("application/json", 0)).success,
  ).toBe(true);
  expect(
    RetentionIndexSchema.safeParse(entry("application/json", 1)).success,
  ).toBe(false);
  for (const mime of ["text/plain", "text/csv", "text/tab-separated-values"]) {
    expect(RetentionIndexSchema.safeParse(entry(mime, 0)).success).toBe(false);
    expect(RetentionIndexSchema.safeParse(entry(mime, 1)).success).toBe(true);
    expect(RetentionIndexSchema.safeParse(entry(mime, 50)).success).toBe(true);
    expect(RetentionIndexSchema.safeParse(entry(mime, 51)).success).toBe(false);
  }
});
