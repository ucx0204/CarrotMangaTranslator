import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { RetentionIndexSchema } from "../src/main/mcp/mcpRetentionRecords";

it("requires zero page changes for research plans while preserving existing page and context record bounds", () => {
  const entry = {
    id: randomUUID(),
    owner: "research-owner",
    operation: "carrot_prepare_research_batch",
    requestId: randomUUID(),
    createdAt: 1,
    expiresAt: 1000,
    bytes: 100,
    mimeType: null,
    sha256: null,
  };
  const accepts = (kind: string, pageCount: number) =>
    RetentionIndexSchema.safeParse({
      version: 1,
      entries: [{ ...entry, kind, pageCount }],
    }).success;
  expect(accepts("research-batch", 0)).toBe(true);
  for (const pages of [-1, 1, 50, 1000, 1001])
    expect(accepts("research-batch", pages)).toBe(false);
  for (const kind of ["change", "output", "workflow"]) {
    for (const pages of [1, 50]) expect(accepts(kind, pages)).toBe(true);
    for (const pages of [0, 51]) expect(accepts(kind, pages)).toBe(false);
  }
  expect(accepts("context", 0)).toBe(true);
  expect(accepts("research-proposal", 0)).toBe(true);
  expect(accepts("unregistered-kind", 0)).toBe(false);
});
