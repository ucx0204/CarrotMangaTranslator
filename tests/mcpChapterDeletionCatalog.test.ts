import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { RetentionIndexSchema } from "../src/main/mcp/mcpRetentionRecords";

it("keeps chapter recovery bounded and non-downloadable without relaxing existing page records", () => {
  const entry = {
    id: randomUUID(),
    owner: "owner",
    kind: "chapter-deletion",
    operation: "carrot_delete_chapter",
    requestId: randomUUID(),
    createdAt: 1,
    expiresAt: 2,
    bytes: 10,
    pageCount: 0,
    mimeType: null,
    sha256: null,
  };
  const accepts = (patch: object) =>
    RetentionIndexSchema.safeParse({
      version: 1,
      entries: [{ ...entry, ...patch }],
    }).success;
  expect(accepts({})).toBe(true);
  expect(accepts({ pageCount: 50 })).toBe(true);
  for (const patch of [
    { pageCount: 51 },
    { pageCount: -1 },
    { mimeType: "image/png" },
    { mimeType: "application/zip" },
    { sha256: "a".repeat(64) },
    { kind: "change" },
    { kind: "output" },
    { kind: "workflow" },
    { kind: "library", pageCount: 1 },
    { kind: "research-batch", pageCount: 1 },
  ])
    expect(accepts(patch)).toBe(false);
  for (const kind of ["change", "output", "workflow"])
    expect(accepts({ kind, pageCount: 1 })).toBe(true);
});
