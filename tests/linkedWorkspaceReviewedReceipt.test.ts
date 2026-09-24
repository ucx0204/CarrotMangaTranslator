import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import type { ReviewedFixture } from "./linkedWorkspaceReviewedOutput.fixture";
import type { McpOutputSyncSession } from "../src/main/mcp/mcpOutputSyncRepository";

it("settles actual native writer effects through the encrypted receipt repository without nesting library transactions", async () => {
  const retained = await retentionFixture();
  let native: ReviewedFixture | undefined;
  try {
    const electron = await import("electron");
    // Extend the existing Electron process boundary, leaving storage and locks real.
    Object.assign(electron.app, { getVersion: () => "native-ledger-parity" });
    const { McpOutputSyncRepository } =
      await import("../src/main/mcp/mcpOutputSyncRepository");
    const { reviewedWorkspace, reviewedTarget } =
      await import("./linkedWorkspaceReviewedOutput.fixture");
    vi.useFakeTimers();
    native = await reviewedWorkspace([1]);
    const review = await native.service.reviewedOutput.preflight(
      native.selection,
      () => undefined,
    );
    const repository = new McpOutputSyncRepository(retained.storage);
    const request = {
      ...reviewedTarget(review),
      requestId: randomUUID(),
      confirm: true as const,
      acknowledgePartialPublication: true as const,
      acknowledgeSavedTextMirror: true as const,
    };
    const started = await repository.begin(
      "native-sync-owner",
      { request, jobId: randomUUID() },
      review,
      () => undefined,
    );
    if (!started.session) throw new Error("fixture receipt session missing");
    const session = started.session;
    const settlements = new Map<
      string,
      Awaited<ReturnType<McpOutputSyncSession["recordIntent"]>>
    >();
    const result = await native.service.reviewedOutput.execute(
      reviewedTarget(review),
      {
        signal: new AbortController().signal,
        assertAuthorized: () => undefined,
        onIntent: async (intent) => {
          settlements.set(
            intent.fileId,
            await session.recordIntent(intent, () => undefined),
          );
        },
        onEffect: async (effect) => {
          const settlement = settlements.get(effect.fileId);
          if (!settlement)
            throw new Error("fixture effect lacks durable admission");
          await settlement.settle(effect);
        },
      },
    );
    expect(result).toMatchObject({
      status: "completed",
      metadata: "published",
      mirror: "published",
    });
    const receipt = await session.finish(result);
    expect(receipt).toMatchObject({
      status: "completed",
      publicationUnconfirmed: 0,
      publishedBytes: result.publishedBytes,
    });
    expect(receipt.files).toEqual(result.files);
    expect(JSON.stringify(receipt)).not.toContain(native.output);
    expect(JSON.stringify(receipt)).not.toContain("relativePath");
    const encrypted = await readFile(
      await retained.storage.path(started.id),
      "utf8",
    );
    expect(encrypted).not.toContain("relativePath");
    const reconstructed = new McpOutputSyncRepository(retained.storage);
    expect(
      await reconstructed.find("native-sync-owner", request, () => undefined),
    ).toMatchObject({
      id: started.id,
      historical: true,
      status: "completed",
    });
    const input = await reconstructed.inspectEvidenceInput(
      "native-sync-owner",
      started.id,
      () => undefined,
    );
    const evidence = await native.service.reviewedOutput.inspectReceiptEvidence(
      input,
      () => undefined,
    );
    expect(evidence.destination).toBe("matched");
    expect(
      evidence.files.find((file) => file.fileId.startsWith("result:"))
        ?.currentState,
    ).toBe("matches_planned");
    expect(native.renderPage).toHaveBeenCalledTimes(1);
  } finally {
    await native?.dispose();
    vi.useRealTimers();
    await retained.close();
  }
});
