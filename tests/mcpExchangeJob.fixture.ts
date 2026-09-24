import { randomUUID } from "node:crypto";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  McpExchangeFileArtifactSchema,
  mcpExchangeIdentity,
} from "../src/shared/mcpExchangeFiles";
import {
  McpTextExportTargetSchema,
  McpTextImportApplySchema,
} from "../src/shared/mcpTextExchange";
import { McpContextExportSchema } from "../src/shared/mcpContextExchange";
import { persistedMcpJobResult } from "../src/main/application/mcpJobJournal";

export function exchangeJobData(
  format: "txt" | "csv" | "tsv" | "context" = "csv",
) {
  const requestId = randomUUID();
  const binding =
    format === "context"
      ? {
          kind: "context",
          workId: "work",
          chapterId: "chapter",
          scope: "guide",
          snapshot: "0123456789abcdef",
        }
      : {
          kind: "text",
          workId: "work",
          chapterId: "chapter",
          direction: "rtl",
          snapshot: "0123456789abcdef",
          pages: ["first", "second"].map((pageId) => ({
            pageId,
            revision: "page-v1:0123456789abcdef",
          })),
          options:
            format === "txt"
              ? { format, field: "both", includeHeaders: true }
              : { format, includeBom: true },
        };
  const target =
    format === "context"
      ? McpContextExportSchema.parse({
          workId: "work",
          chapterId: "chapter",
          scope: "guide",
          sourceSnapshot: binding.snapshot,
          requestId,
        })
      : McpTextExportTargetSchema.parse({ binding, requestId });
  const kind = format === "context" ? "contextFileExport" : "textFileExport";
  const parsedBinding =
    McpExchangeFileArtifactSchema.shape.exchange.parse(binding);
  const identity = mcpExchangeIdentity(parsedBinding);
  const result = McpExchangeFileArtifactSchema.parse({
    kind: "exchange-file",
    exchange: parsedBinding,
    mimeType: identity.mimeType,
    filename: `carrot-${identity.name}`,
    url: `https://carrot.test/mcp-artifacts/session/${identity.name}`,
    bytes: 128,
    sha256: "a".repeat(64),
    expiresAt: 600_100,
    access: "single-file-link",
    retainedOutputId: randomUUID(),
    performed: ["serialize", "export"],
  });
  const record = jobRecord(kind, target, result);
  return { target, binding: parsedBinding, result, record };
}
export function textImportJobData() {
  const target = McpTextImportApplySchema.parse({
    batchId: randomUUID(),
    requestId: randomUUID(),
    acknowledgePageByPage: true,
  });
  const result = {
    kind: "text-file-import",
    batchId: target.batchId,
    status: "completed",
    input: {
      uploadId: randomUUID(),
      sha256: "b".repeat(64),
      sourceBytes: 128,
      utf8Bytes: 128,
      format: "csv",
      decoding: "native-utf8-then-windows-949",
    },
    application: "page-by-page",
    performed: ["apply"],
    outcome: {
      batchId: target.batchId,
      chapterId: "chapter",
      contextRevision: "0123456789abcdef",
      reason: "Apply reviewed corrections",
      expiresAt: 600_100,
      status: "completed",
      direction: "apply",
      activeRequestId: target.requestId,
      cancellationRequested: false,
      pages: [
        {
          pageId: "first",
          expectedRevision: "page-v1:0123456789abcdef",
          state: "applied",
          changedBlocks: 1,
          result: "saved",
          errorCode: null,
        },
      ],
      totalChanges: 1,
      excludedChanges: 0,
      canApply: false,
      canUndo: true,
      canRedo: false,
      warnings: ["session_history_not_durable"],
    },
  };
  return {
    target,
    result,
    record: jobRecord("textFileImport", target, result),
  };
}
function jobRecord(
  kind: string,
  target: { requestId: string },
  result: Record<string, unknown>,
) {
  return {
    id: randomUUID(),
    owner: "owner",
    requestId: target.requestId,
    kind,
    parameters: target,
    fingerprint: hashStableValue([kind, target]),
    status: "completed",
    progress: { phase: "done" },
    result: persistedMcpJobResult(result),
    startedAt: 100,
    finishedAt: 101,
    cancellationRequested: false,
  };
}
