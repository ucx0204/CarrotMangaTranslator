import { randomUUID } from "node:crypto";
import { ok } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { MCP_COMPOSITE_BYTES } from "../src/shared/mcpCompositeWorkflow";
import {
  compositeFingerprint,
  reserveCompositeCost,
  zeroCompositeCost,
} from "../src/main/application/mcpCompositeWorkflowPolicy";
import { parseCompositeRecord } from "../src/main/application/mcpCompositeWorkflowRecord";
import {
  compositeDigest,
  compositeEvidence,
  compositeOwner,
  newCompositeRecord,
  compositeBound,
  compositeReserved,
} from "./mcpCompositeRepository.fixture";

it("rejects stale versions, reserved-counter refunds and raw child payloads without replacing encrypted bytes", async () => {
  const f = await retentionFixture();
  const { McpCompositeRepository } =
    await import("../src/main/mcp/mcpCompositeRepository");
  const repository = new McpCompositeRepository(f.storage);
  const guard = () => undefined;
  try {
    const prepared = await repository.create(newCompositeRecord(), guard);
    const bound = await repository.save(
      compositeBound(prepared),
      prepared.version,
      guard,
    );
    const before = await readFile(await f.storage.path(bound.id));
    await expect(
      repository.save(compositeBound(prepared), prepared.version, guard),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const raw = structuredClone(bound);
    raw.version += 1;
    ok(raw.phases[0].binding);
    Object.assign(raw.phases[0].binding, {
      action: {
        kind: "workflow-run",
        input: { url: "https://private.invalid/capability" },
      },
    });
    await expect(repository.save(raw, bound.version, guard)).rejects.toThrow();
    const altered = structuredClone(bound);
    altered.version += 1;
    altered.actions[0].fingerprint = "d".repeat(64);
    await expect(
      repository.save(altered, bound.version, guard),
    ).rejects.toThrow("receipts");
    expect(await readFile(await f.storage.path(bound.id))).toEqual(before);
    const admitted = await repository.reserve(
      compositeReserved(bound),
      bound.version,
      guard,
    );
    const held = await admitted.settlement.hold("interrupted");
    const refunded = {
      ...held,
      version: held.version + 1,
      used: zeroCompositeCost(),
    };
    await expect(
      repository.save(refunded, held.version, guard),
    ).rejects.toThrow("refunded");
  } finally {
    await f.close();
  }
});

it("stops at the durable 128-action cap before granting another native capability", async () => {
  const f = await retentionFixture();
  const { McpCompositeRepository } =
    await import("../src/main/mcp/mcpCompositeRepository");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  const repository = new McpCompositeRepository(f.storage);
  const guard = () => undefined;
  try {
    const prepared = await repository.create(newCompositeRecord(), guard);
    const full = compositeBound(prepared);
    full.version = 128;
    full.actions = Array.from({ length: 128 }, (_, index) => ({
      requestId: randomUUID(),
      fingerprint: compositeFingerprint(index),
    }));
    // Seed valid prior history through the real encrypted native journal without
    // executing 128 unrelated controls just to reach the boundary under test.
    await withLibraryMutation(() =>
      runLibraryTransaction(
        "test-composite-full-history",
        async (transaction) => {
          await f.storage.stageRecord(
            transaction,
            full.id,
            parseCompositeRecord(full),
          );
        },
      ),
    );
    const attempt = structuredClone(full);
    attempt.version += 1;
    attempt.status = "running";
    attempt.phases[0].status = "running";
    attempt.phases[0].attemptId = randomUUID();
    ok(attempt.phases[0].binding);
    reserveCompositeCost(attempt, attempt.phases[0].binding.cost);
    await expect(
      repository.reserve(attempt, full.version, guard),
    ).rejects.toThrow("action history");
    expect(
      (await repository.load(compositeOwner, full.id)).used.admissions,
    ).toBe(0);
    expect(repository.isActive(full.id)).toBe(false);
    const overflow = structuredClone(full);
    overflow.version += 1;
    overflow.actions.push({
      requestId: randomUUID(),
      fingerprint: compositeDigest,
    });
    await expect(
      repository.save(overflow, full.version, guard),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("caps actual UTF-8 parent metadata even when bounded host findings fit the character limits", () => {
  const record = newCompositeRecord();
  record.plan.phases = [
    { kind: "review", id: "review-one" },
    { kind: "review", id: "review-two" },
  ];
  record.plan.maxReviewPasses = 2;
  record.initialFingerprint = compositeFingerprint(record.plan);
  record.status = "completed";
  record.used.admissions = 2;
  record.used.pageAttempts = 2;
  record.phases = record.plan.phases.map((phase, index) => {
    const page = record.snapshot.pages[0];
    const evidence = {
      ...compositeEvidence(record, 0, index + 1),
      phaseId: phase.id,
    };
    return {
      id: phase.id,
      status: "completed" as const,
      evidence: [evidence],
      report: {
        id: record.id,
        version: record.version,
        requestId: randomUUID(),
        phaseId: phase.id,
        pass: index + 1,
        reviewerKind: "connected-ai" as const,
        verdictOrigin: "host-reported" as const,
        verdict: "accepted" as const,
        assessments: [
          {
            chapterId: page.chapterId,
            pageId: page.pageId,
            evidenceId: evidence.id,
          },
        ],
        findingsOverflow: false,
        findings: Array.from({ length: 250 }, () => ({
          chapterId: page.chapterId,
          pageId: page.pageId,
          category: "typography" as const,
          severity: "advisory" as const,
          message: "한".repeat(1000),
        })),
      },
    };
  });
  expect(JSON.stringify(record).length).toBeLessThan(MCP_COMPOSITE_BYTES);
  expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeGreaterThan(
    MCP_COMPOSITE_BYTES,
  );
  expect(() => parseCompositeRecord(record)).toThrow("one MiB");
});

it("rejects invalid composite catalog metadata without replacing its encrypted preparation or index", async () => {
  const f = await retentionFixture();
  const { McpCompositeRepository } =
    await import("../src/main/mcp/mcpCompositeRepository");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  const repository = new McpCompositeRepository(f.storage);
  try {
    const prepared = await repository.create(newCompositeRecord(), () => {});
    const index = await f.storage.index();
    const indexPath = await f.storage.path();
    const recordPath = await f.storage.path(prepared.id);
    const originalIndex = await readFile(indexPath);
    const originalRecord = await readFile(recordPath);
    for (const patch of [
      { pageCount: 51 },
      { mimeType: "image/png" },
      { sha256: "a".repeat(64) },
      { operation: "carrot_export_page_png" },
      { requestId: null },
      { requestId: "not-a-uuid" },
    ]) {
      const candidate = structuredClone(index);
      const entry = candidate.entries.find((item) => item.id === prepared.id);
      ok(entry);
      Object.assign(entry, patch);
      await expect(
        withLibraryMutation(() =>
          runLibraryTransaction(
            "test-invalid-composite-catalog",
            (transaction) => f.storage.stageIndex(transaction, candidate),
          ),
        ),
      ).rejects.toThrow(
        "Composite metadata requires zero to fifty exact pages",
      );
      expect(await readFile(indexPath)).toEqual(originalIndex);
      expect(await readFile(recordPath)).toEqual(originalRecord);
    }
    expect(await repository.load(compositeOwner, prepared.id)).toEqual(
      prepared,
    );
    expect((await f.list("outputs")).total).toBe(0);
  } finally {
    await f.close();
  }
});
