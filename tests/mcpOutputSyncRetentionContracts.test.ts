import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  MCP_RETENTION_MS,
  RetentionIndexSchema,
  type RetentionEntry,
} from "../src/main/mcp/mcpRetentionRecords";

function receiptEntry(): RetentionEntry {
  return {
    id: randomUUID(),
    owner: "sync-owner",
    kind: "output-sync",
    operation: "carrot_sync_output",
    requestId: randomUUID(),
    createdAt: 1000,
    expiresAt: 1000 + MCP_RETENTION_MS,
    bytes: 200,
    pageCount: 1,
    mimeType: null,
    sha256: null,
  };
}

it("retains output synchronization as bounded metadata with its original native request identity", () => {
  for (const pageCount of [1, 50]) {
    const entry = { ...receiptEntry(), pageCount };
    expect(
      RetentionIndexSchema.parse({ version: 1, entries: [entry] }),
    ).toEqual({ version: 1, entries: [entry] });
  }
});

const invalid: Array<{ reason: string; patch: Partial<RetentionEntry> }> = [
  { reason: "no selected pages", patch: { pageCount: 0 } },
  { reason: "more than fifty selected pages", patch: { pageCount: 51 } },
  {
    reason: "download MIME attached to a native destination receipt",
    patch: { mimeType: "image/png" },
  },
  {
    reason: "download hash attached to a native destination receipt",
    patch: { sha256: "a".repeat(64) },
  },
  {
    reason: "another operation claiming a synchronization receipt",
    patch: { operation: "carrot_export_page_png" },
  },
  { reason: "missing native request identity", patch: { requestId: null } },
  {
    reason: "malformed native request identity",
    patch: { requestId: "not-a-uuid" },
  },
];

it.each(invalid)(
  "rejects $reason without admitting a downloadable output",
  ({ patch }) => {
    const parsed = RetentionIndexSchema.safeParse({
      version: 1,
      entries: [{ ...receiptEntry(), ...patch }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success)
      throw new Error("Malformed native publication receipt was accepted");
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["entries", 0],
        message:
          "Output synchronization requires one to fifty pages, its exact request identity and no downloadable payload.",
      }),
    );
  },
);
