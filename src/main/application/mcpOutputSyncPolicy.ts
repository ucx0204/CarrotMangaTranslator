import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpSyncOutputSchema,
  McpOutputSyncPreflightSchema,
  McpOutputSyncEffectSchema,
  McpOutputSyncResultSchema,
  McpOutputSyncReceiptSchema,
  type McpSyncOutput,
  type McpOutputSyncPreflight,
  type McpOutputSyncEffect,
  type McpOutputSyncResult,
} from "../../shared/mcpOutputSync";
import {
  McpOutputSyncIntentSchema,
  RetainedOutputSyncSchema,
  sameOutputSyncValue,
  outputSyncIntentMatchesReview,
  type McpOutputSyncIntent,
  type RetainedOutputSync,
} from "../../shared/mcpOutputSyncState";
import { outputSyncPublicationState } from "../../shared/mcpOutputSyncPublication";
import { McpEditError } from "./mcpEditPolicy";

function invalid(message: string): never {
  throw new McpEditError("invalid_edit", message);
}
/** Validate through the exact persisted schema, before any destination effect. */
export function createOutputSyncRecord(input: {
  id: string;
  owner: string;
  jobId: string;
  now: number;
  request: McpSyncOutput;
  review: McpOutputSyncPreflight;
}): RetainedOutputSync {
  const request = McpSyncOutputSchema.parse(input.request);
  const review = McpOutputSyncPreflightSchema.parse(input.review);
  return RetainedOutputSyncSchema.parse({
    version: 1,
    id: input.id,
    owner: input.owner,
    jobId: input.jobId,
    createdAt: input.now,
    expiresAt: input.now + 7 * 24 * 60 * 60 * 1000,
    request,
    signature: hashStableValue(request),
    review,
    reviewHash: hashStableValue(review),
    admissions: [],
    result: null,
    finishedAt: null,
  });
}
export function assertOutputSyncRequest(
  record: RetainedOutputSync,
  request: McpSyncOutput,
) {
  const checked = McpSyncOutputSchema.parse(request);
  if (
    record.signature !== hashStableValue(checked) ||
    !sameOutputSyncValue(record.request, checked)
  )
    invalid("Output sync requestId belongs to another reviewed request.");
}
export function admitOutputSyncIntent(
  record: RetainedOutputSync,
  input: McpOutputSyncIntent,
  now: number,
) {
  const intent = McpOutputSyncIntentSchema.parse(input);
  if (record.result || record.expiresAt <= now)
    invalid("Output sync admission is closed or expired.");
  if (record.admissions.some((item) => item.intent.fileId === intent.fileId))
    invalid("A publication intent cannot authorize another OS effect.");
  if (record.admissions.some((item) => item.effect === null))
    invalid("Settle the admitted publication before authorizing another.");
  if (!outputSyncIntentMatchesReview(intent, record.review))
    invalid("Publication differs from its reviewed allocation.");
  const registry = record.admissions.filter(
    (item) => item.intent.role === "registry",
  );
  if (
    intent.role === "registry" &&
    intent.fileId !== `registry:${registry.length}:publish`
  )
    invalid("Registry publication sequence differs from its admitted history.");
  return RetainedOutputSyncSchema.parse({
    ...record,
    admissions: [
      ...record.admissions,
      {
        sequence: record.admissions.length,
        admittedAt: now,
        intent,
        effect: null,
      },
    ],
  });
}
/** No current permission, revision or destination checks: this settles one issued capability. */
export function settleOutputSyncEffect(
  record: RetainedOutputSync,
  sequence: number,
  input: McpOutputSyncEffect,
) {
  const effect = McpOutputSyncEffectSchema.parse(input);
  const admitted = record.admissions[sequence];
  if (!admitted) invalid("Output sync effect has no admitted intent.");
  if (admitted.effect) {
    if (!sameOutputSyncValue(admitted.effect, effect))
      invalid("Output sync effect was already settled differently.");
    return record;
  }
  if (record.result) invalid("Output sync settlement is already closed.");
  return RetainedOutputSyncSchema.parse({
    ...record,
    admissions: record.admissions.map((item) =>
      item.sequence === sequence ? { ...item, effect } : item,
    ),
  });
}
export function finishOutputSyncRecord(
  record: RetainedOutputSync,
  input: McpOutputSyncResult,
  now: number,
) {
  const result = McpOutputSyncResultSchema.parse(input);
  if (record.result) {
    if (!sameOutputSyncValue(record.result, result))
      invalid("Output sync already finished with another result.");
    return record;
  }
  return RetainedOutputSyncSchema.parse({ ...record, result, finishedAt: now });
}
export function failOutputSyncRecord(
  record: RetainedOutputSync,
  errorCode: NonNullable<McpOutputSyncResult["errorCode"]>,
  cancelled: boolean,
  now: number,
) {
  if (record.result) return record;
  const receipt = projectOutputSyncReceipt(record, false, true);
  return finishOutputSyncRecord(
    record,
    {
      status: cancelled
        ? "cancelled"
        : record.admissions.length > 0
          ? "partial"
          : "failed",
      errorCode,
      files: receipt.files,
      publishedBytes: receipt.publishedBytes,
      metadata: receipt.metadata,
      mirror: receipt.mirror,
    },
    now,
  );
}
/** Private allocations never enter a job/result, including unfinished publications. */
export function projectOutputSyncReceipt(
  record: RetainedOutputSync,
  active: boolean,
  historical: boolean,
) {
  const files = projectOutputSyncFiles(record);
  const publicationUnconfirmed = files.filter(
    (file) => file.state === "publication_unconfirmed",
  ).length;
  return McpOutputSyncReceiptSchema.parse({
    id: record.id,
    requestId: record.request.requestId,
    jobId: record.jobId,
    chapterId: record.request.chapterId,
    connectionId: record.request.connectionId,
    pageIds: record.request.pageIds,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.result?.status ?? (active ? "running" : "interrupted"),
    historical,
    sourceChecked: false,
    files,
    publishedBytes: record.admissions.reduce(
      (sum, item) => sum + (item.effect?.bytes ?? 0),
      0,
    ),
    reportedPublishedBytes: record.result?.publishedBytes ?? null,
    publicationUnconfirmed,
    errorCode: record.result?.errorCode ?? null,
    ...outputSyncPublicationState(
      files,
      record.review.registryPublications.maximum,
    ),
  });
}

function projectOutputSyncFiles(record: RetainedOutputSync) {
  const files = record.review.files.map((file) => ({
    ...file,
    state: "planned" as
      | "planned"
      | "publication_unconfirmed"
      | "published"
      | "removed"
      | "failed",
    bytes: null as number | null,
    sha256: null as string | null,
    completedAt: null as number | null,
  }));
  for (const item of record.admissions) {
    const { relativePath: _path, desired: _desired, ...file } = item.intent;
    const outcome = {
      ...file,
      state: "publication_unconfirmed" as const,
      bytes: null,
      sha256: null,
      completedAt: null,
      ...item.effect,
    };
    const index = files.findIndex(
      (candidate) => candidate.fileId === file.fileId,
    );
    if (index < 0) files.push(outcome);
    else files[index] = outcome;
  }
  const finalFiles = new Map(
    record.result?.files.map((file) => [file.fileId, file]),
  );
  for (const file of files) {
    if (
      file.state === "planned" &&
      finalFiles.get(file.fileId)?.state === "failed"
    )
      file.state = "failed";
  }
  return files;
}
