import { randomUUID } from "node:crypto";
import {
  MCP_OUTPUT_SYNC_LIMITS,
  type McpOutputSyncPreflight,
} from "../src/shared/mcpOutputSync";
import type { McpOutputSyncIntent } from "../src/shared/mcpOutputSyncState";

export const syncOwner = "sync-owner";
const syncHash = "a".repeat(64);
export function syncReview(): McpOutputSyncPreflight {
  return {
    chapterId: "chapter",
    connectionId: "connection",
    pageIds: ["page"],
    selectionSnapshot: "1".repeat(16),
    destinationSnapshot: "2".repeat(16),
    sourceSnapshot: "3".repeat(16),
    pages: [
      {
        pageId: "page",
        revision: "page-v1:" + "4".repeat(16),
        visualRevision: "page-visual-v1:" + "5".repeat(16),
        format: "png",
      },
    ],
    mirrorScope: {
      chapters: [
        { chapterId: "chapter", connectionId: "connection", pageIds: ["page"] },
      ],
      pageCount: 1,
      includesSavedText: true,
    },
    files: [
      {
        fileId: "result:page:publish",
        role: "result",
        pageId: "page",
        action: "publish",
        previous: null,
      },
      {
        fileId: "mirror:publish",
        role: "mirror",
        pageId: null,
        action: "publish",
        previous: null,
      },
    ],
    limits: MCP_OUTPUT_SYNC_LIMITS,
    registryPublications: { maximum: 2, privateMetadataOnly: true },
    executionReserved: false,
    partialPublication: true,
  };
}
export function syncRequest(review = syncReview()) {
  return {
    chapterId: review.chapterId,
    connectionId: review.connectionId,
    pageIds: review.pageIds,
    selectionSnapshot: review.selectionSnapshot,
    destinationSnapshot: review.destinationSnapshot,
    sourceSnapshot: review.sourceSnapshot,
    requestId: randomUUID(),
    confirm: true as const,
    acknowledgePartialPublication: true as const,
    acknowledgeSavedTextMirror: true as const,
  };
}
export function syncIntents(review = syncReview()): McpOutputSyncIntent[] {
  const registry = (sequence: number): McpOutputSyncIntent => ({
    fileId: `registry:${sequence}:publish`,
    role: "registry",
    pageId: null,
    action: "publish",
    previous: sequence === 0 ? null : { bytes: 4, sha256: syncHash },
    relativePath: null,
    desired: { bytes: 4, sha256: syncHash },
  });
  return [
    {
      ...review.files[0],
      relativePath: "results/private-page.png",
      desired: { bytes: 9, sha256: syncHash },
    },
    registry(0),
    {
      ...review.files[1],
      relativePath: "private-root.manga.json",
      desired: { bytes: 7, sha256: syncHash },
    },
    registry(1),
  ];
}
export function syncEffect(
  intent: McpOutputSyncIntent,
  completedAt = Date.now(),
) {
  return {
    fileId: intent.fileId,
    state:
      intent.action === "publish"
        ? ("published" as const)
        : ("removed" as const),
    bytes: intent.desired?.bytes ?? 0,
    sha256: intent.desired?.sha256 ?? null,
    completedAt,
  };
}
