import { randomUUID } from "node:crypto";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  McpWorkFileExportMetadataSchema,
  McpWorkFileExportTargetSchema,
} from "../src/shared/mcpWorkFileExport";
import { persistedMcpJobResult } from "../src/main/application/mcpJobJournal";

export function workFileJobData() {
  const target = McpWorkFileExportTargetSchema.parse({
    workId: "work",
    chapterIds: ["chapter-first", "chapter-second"],
    snapshot: "0123456789abcdef",
    sourceSnapshot: "1234567890abcdef",
    requestId: randomUUID(),
    acknowledgeOriginalImages: true,
    acknowledgeV1Limitations: true,
  });
  const metadata = McpWorkFileExportMetadataSchema.parse({
    workId: target.workId,
    chapterIds: target.chapterIds,
    snapshot: target.snapshot,
    sourceSnapshot: target.sourceSnapshot,
    format: "mgtshare-v1",
    chapterCount: 2,
    pageCount: 3,
    blockCount: 4,
  });
  const result = {
    kind: "native-work-file",
    mimeType: "application/vnd.carrot.mgtshare",
    filename: "carrot-work.mgtshare",
    url: "https://carrot.test/mcp-artifacts/session/work.mgtshare",
    bytes: 128,
    sha256: "a".repeat(64),
    expiresAt: 600_100,
    access: "single-file-link",
    retainedOutputId: randomUUID(),
    workFileExport: metadata,
    performed: ["package", "export"],
  };
  const record = {
    id: randomUUID(),
    owner: "owner",
    requestId: target.requestId,
    kind: "workFileExport",
    parameters: target,
    fingerprint: hashStableValue(["workFileExport", target]),
    status: "completed",
    progress: { phase: "done" },
    result: persistedMcpJobResult(result),
    startedAt: 100,
    finishedAt: 101,
    cancellationRequested: false,
  };
  return { target, metadata, result, record };
}
