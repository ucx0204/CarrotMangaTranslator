import { expect, it } from "vitest";
import { RetentionIndexSchema } from "../src/main/mcp/mcpRetentionRecords";
import { mcpContextMigrationOutputs } from "../src/shared/mcpContextMigration";

const entry = {
  id: "e7b7e3fa-df88-42ce-a159-b747d7f5d067",
  owner: "owner",
  operation: "carrot_apply_context_migration",
  requestId: null,
  createdAt: 1,
  expiresAt: 2,
  bytes: 100,
  pageCount: 0,
  mimeType: null,
  sha256: null,
};

it.each([0, 1, 50, 1000])(
  "accepts %s context pages and its bounded public list descriptor",
  (pageCount) => {
    expect(
      RetentionIndexSchema.parse({
        version: 1,
        entries: [{ ...entry, kind: "context", pageCount }],
      }).entries[0].pageCount,
    ).toBe(pageCount);
    const { owner: _owner, bytes, ...metadata } = entry;
    expect(
      mcpContextMigrationOutputs.carrot_list_context_migrations.parse({
        total: 1,
        offset: 0,
        limit: 25,
        snapshot: "0".repeat(16),
        nextOffset: null,
        retention:
          "seven-days; same-profile-and-owner; no-automatic-reexecution",
        items: [
          {
            ...metadata,
            kind: "context",
            pageCount,
            storageBytes: bytes,
            available: true,
          },
        ],
      }).items,
    ).toHaveLength(1);
  },
);

it.each(["change", "output", "workflow"])(
  "preserves the prior one-to-fifty page limit for %s",
  (kind) => {
    for (const pageCount of [0, 51, 1000])
      expect(
        RetentionIndexSchema.safeParse({
          version: 1,
          entries: [{ ...entry, kind, pageCount }],
        }).success,
      ).toBe(false);
    for (const pageCount of [1, 50])
      expect(
        RetentionIndexSchema.safeParse({
          version: 1,
          entries: [{ ...entry, kind, pageCount }],
        }).success,
      ).toBe(true);
  },
);

it("rejects oversized or fractional context page metadata", () => {
  for (const pageCount of [-1, 0.5, 1001])
    expect(
      RetentionIndexSchema.safeParse({
        version: 1,
        entries: [{ ...entry, kind: "context", pageCount }],
      }).success,
    ).toBe(false);
});
