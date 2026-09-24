import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { RasterExportSettingsSchema } from "../src/shared/linkedWorkspaceSchemas";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";
import { REVIEWED_OUTPUT_LIMITS } from "../src/main/linkedWorkspace/linkedWorkspaceReviewedOutputTypes";
import {
  MCP_OUTPUT_SYNC_LIMITS,
  McpOutputDestinationSchema,
  McpSyncOutputSchema,
  McpGetOutputSyncSchema,
  mcpOutputSyncInputs,
  mcpOutputSyncOutputs,
} from "../src/shared/mcpOutputSync";
import {
  McpOutputSyncIntentSchema,
  RetainedOutputSyncSchema,
} from "../src/shared/mcpOutputSyncState";
import {
  createOutputSyncRecord,
  admitOutputSyncIntent,
  settleOutputSyncEffect,
  finishOutputSyncRecord,
  failOutputSyncRecord,
  projectOutputSyncReceipt,
} from "../src/main/application/mcpOutputSyncPolicy";
import {
  syncOwner,
  syncReview,
  syncRequest,
  syncIntents,
  syncEffect,
} from "./mcpOutputSync.fixture";

function initial() {
  const review = syncReview();
  return createOutputSyncRecord({
    id: randomUUID(),
    owner: syncOwner,
    jobId: randomUUID(),
    now: 1000,
    review,
    request: syncRequest(review),
  });
}

describe("strict output sync contracts", () => {
  it("uses schema-convertible MCP v4 boundaries and matches native limits/settings", () => {
    expect(MCP_OUTPUT_SYNC_LIMITS).toEqual(REVIEWED_OUTPUT_LIMITS);
    for (const schema of [
      ...Object.values(mcpOutputSyncInputs),
      ...Object.values(mcpOutputSyncOutputs),
    ])
      expect(z.toJSONSchema(schema)).toBeDefined();
    for (const format of ["source", "png", "jpeg", "webp"] as const) {
      const output = { ...DEFAULT_RASTER_EXPORT_SETTINGS, format };
      const actual = McpOutputDestinationSchema.parse({
        chapterId: "chapter",
        connectionId: "connection",
        destinationKind: "managed",
        enabled: true,
        available: true,
        reason: null,
        output,
        mirrorScope: null,
      });
      expect(actual.output).toEqual(RasterExportSettingsSchema.parse(output));
    }
    expect(
      McpSyncOutputSchema.safeParse({
        ...syncRequest(),
        destinationPath: "C:/private",
      }).success,
    ).toBe(false);
    expect(
      McpSyncOutputSchema.safeParse({
        ...syncRequest(),
        acknowledgePartialPublication: false,
      }).success,
    ).toBe(false);
    expect(
      McpSyncOutputSchema.safeParse({
        ...syncRequest(),
        acknowledgeSavedTextMirror: false,
      }).success,
    ).toBe(false);
    expect(
      McpGetOutputSyncSchema.safeParse({
        id: randomUUID(),
        requestId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it.each([
    "../escaped.png",
    "/absolute.png",
    "C:/drive.png",
    "dir\\file.png",
    "dir//file.png",
    "./file.png",
  ])("rejects private allocation %s before admission", (relativePath) => {
    expect(
      McpOutputSyncIntentSchema.safeParse({ ...syncIntents()[0], relativePath })
        .success,
    ).toBe(false);
  });

  it("binds exact selected order, limits, all reviewed snapshots and content hashes", () => {
    const record = initial();
    expect(
      RetainedOutputSyncSchema.safeParse({
        ...record,
        request: { ...record.request, sourceSnapshot: "0".repeat(16) },
      }).success,
    ).toBe(false);
    expect(
      RetainedOutputSyncSchema.safeParse({
        ...record,
        reviewHash: "0".repeat(16),
      }).success,
    ).toBe(false);
    expect(
      RetainedOutputSyncSchema.safeParse({
        ...record,
        expiresAt: record.expiresAt + 1,
      }).success,
    ).toBe(false);
    expect(() =>
      createOutputSyncRecord({
        id: randomUUID(),
        owner: syncOwner,
        jobId: randomUUID(),
        now: 1000,
        request: record.request,
        review: {
          ...record.review,
          pages: [{ ...record.review.pages[0], pageId: "foreign" }],
        },
      }),
    ).toThrow();
    expect(() =>
      admitOutputSyncIntent(
        record,
        { ...syncIntents()[0], pageId: "foreign" },
        1001,
      ),
    ).toThrow();
    expect(() =>
      admitOutputSyncIntent(
        record,
        {
          ...syncIntents()[2],
          desired: {
            bytes: MCP_OUTPUT_SYNC_LIMITS.mirrorBytes + 1,
            sha256: "a".repeat(64),
          },
        },
        1001,
      ),
    ).toThrow();
  });

  it("accepts the bounded complete mirror scope including an empty connected chapter", () => {
    const record = initial();
    const review = {
      ...record.review,
      mirrorScope: {
        ...record.review.mirrorScope,
        chapters: [
          ...record.review.mirrorScope.chapters,
          { chapterId: "empty", connectionId: "empty-connection", pageIds: [] },
        ],
      },
    };
    expect(
      createOutputSyncRecord({
        id: record.id,
        owner: record.owner,
        jobId: record.jobId,
        now: record.createdAt,
        request: record.request,
        review,
      }).review.mirrorScope.chapters,
    ).toHaveLength(2);
  });
});

describe("durable publication policy", () => {
  it("requires exact digest settlement and permits only an identical receipt retry", () => {
    const intent = syncIntents()[0];
    const record = admitOutputSyncIntent(initial(), intent, 1001);
    const effect = syncEffect(intent, 1002);
    expect(() =>
      settleOutputSyncEffect(record, 0, {
        ...effect,
        fileId: "mirror:publish",
      }),
    ).toThrow();
    expect(() =>
      settleOutputSyncEffect(record, 0, { ...effect, sha256: "b".repeat(64) }),
    ).toThrow();
    expect(() =>
      settleOutputSyncEffect(record, 0, { ...effect, bytes: 10 }),
    ).toThrow();
    const settled = settleOutputSyncEffect(record, 0, effect);
    expect(settleOutputSyncEffect(settled, 0, effect)).toBe(settled);
    expect(() => admitOutputSyncIntent(settled, intent, 1003)).toThrow(
      "another OS effect",
    );
    expect(() => admitOutputSyncIntent(record, syncIntents()[1], 1002)).toThrow(
      "Settle",
    );
  });

  it("does not upgrade uncertain effects from a native reported byte total", () => {
    const record = admitOutputSyncIntent(initial(), syncIntents()[0], 1001);
    const pending = projectOutputSyncReceipt(record, true, false);
    const finished = finishOutputSyncRecord(
      record,
      {
        status: "partial",
        errorCode: "receipt_failed",
        files: pending.files,
        publishedBytes: 9,
        metadata: "pending",
        mirror: "pending",
      },
      1002,
    );
    const receipt = projectOutputSyncReceipt(finished, false, true);
    expect(receipt).toMatchObject({
      publishedBytes: 0,
      reportedPublishedBytes: 9,
      publicationUnconfirmed: 1,
    });
    expect(() =>
      finishOutputSyncRecord(
        record,
        {
          status: "completed",
          errorCode: null,
          files: pending.files,
          publishedBytes: 9,
          metadata: "published",
          mirror: "published",
        },
        1002,
      ),
    ).toThrow();
    expect(() =>
      finishOutputSyncRecord(
        record,
        {
          status: "partial",
          errorCode: "receipt_failed",
          files: pending.files,
          publishedBytes: 8,
          metadata: "pending",
          mirror: "pending",
        },
        1002,
      ),
    ).toThrow();
  });

  it("handles early failure and cancellation without fabricated effects or reauthorization", () => {
    const before = initial();
    expect(
      projectOutputSyncReceipt(
        failOutputSyncRecord(before, "destination_changed", false, 1001),
        false,
        false,
      ),
    ).toMatchObject({
      status: "failed",
      publishedBytes: 0,
      publicationUnconfirmed: 0,
    });
    const admitted = admitOutputSyncIntent(before, syncIntents()[0], 1001);
    const effect = syncEffect(syncIntents()[0], before.expiresAt + 100);
    const settled = settleOutputSyncEffect(admitted, 0, effect);
    const cancelled = failOutputSyncRecord(
      settled,
      "publication_failed",
      true,
      before.expiresAt + 101,
    );
    expect(projectOutputSyncReceipt(cancelled, false, true)).toMatchObject({
      status: "cancelled",
      publishedBytes: 9,
    });
    expect(() =>
      admitOutputSyncIntent(settled, syncIntents()[1], before.expiresAt),
    ).toThrow("expired");
  });

  it("requires sequential registry identities and distinct external allocations", () => {
    const record = initial();
    expect(() => admitOutputSyncIntent(record, syncIntents()[3], 1001)).toThrow(
      "sequence",
    );
    const result = syncIntents()[0];
    const settled = settleOutputSyncEffect(
      admitOutputSyncIntent(record, result, 1001),
      0,
      syncEffect(result, 1002),
    );
    expect(() =>
      admitOutputSyncIntent(
        settled,
        { ...syncIntents()[2], relativePath: result.relativePath },
        1003,
      ),
    ).toThrow();
    expect(() =>
      admitOutputSyncIntent(
        settled,
        { ...syncIntents()[1], relativePath: "registry.json" },
        1003,
      ),
    ).toThrow();
  });

  it("reserves the aggregate all-role byte cap before granting another publication", () => {
    const base = syncReview();
    const pageIds = ["one", "two", "three", "four"];
    const review = {
      ...base,
      pageIds,
      pages: pageIds.map((pageId) => ({ ...base.pages[0], pageId })),
      files: [
        ...pageIds.map((pageId) => ({
          ...base.files[0],
          pageId,
          fileId: `result:${pageId}:publish`,
        })),
        base.files[1],
      ],
      mirrorScope: {
        ...base.mirrorScope,
        pageCount: 4,
        chapters: [{ ...base.mirrorScope.chapters[0], pageIds }],
      },
      registryPublications: { ...base.registryPublications, maximum: 5 },
    };
    let record = createOutputSyncRecord({
      id: randomUUID(),
      owner: syncOwner,
      jobId: randomUUID(),
      now: 1000,
      review,
      request: syncRequest(review),
    });
    for (const [index, file] of review.files.slice(0, 4).entries()) {
      const intent = {
        ...file,
        relativePath: `result/${file.pageId}.png`,
        desired: {
          bytes: MCP_OUTPUT_SYNC_LIMITS.imageBytes,
          sha256: "a".repeat(64),
        },
      };
      record = settleOutputSyncEffect(
        admitOutputSyncIntent(record, intent, 1001),
        index,
        syncEffect(intent, 1002),
      );
    }
    expect(projectOutputSyncReceipt(record, true, false).publishedBytes).toBe(
      MCP_OUTPUT_SYNC_LIMITS.publishedBytes,
    );
    expect(() =>
      admitOutputSyncIntent(record, syncIntents()[1], 1003),
    ).toThrow();
    expect(() =>
      admitOutputSyncIntent(record, syncIntents()[2], 1003),
    ).toThrow();
  });
});
