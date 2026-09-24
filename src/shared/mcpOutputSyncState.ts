import { z } from "zod/v4";
import { hashStableValue } from "./blockFingerprint";
import { outputSyncPublicationState } from "./mcpOutputSyncPublication";
import {
  MCP_OUTPUT_SYNC_LIMITS,
  McpSyncOutputSchema,
  McpOutputSyncIdSchema,
  McpOutputSyncSnapshotSchema,
  McpOutputSyncPreflightSchema,
  McpOutputSyncFileSchema,
  McpOutputSyncDigestSchema,
  McpOutputSyncEffectSchema,
  McpOutputSyncResultSchema,
  type McpOutputSyncFile,
  type McpOutputSyncPreflight,
  type McpOutputSyncResult,
  type McpOutputSyncEffect,
} from "./mcpOutputSync";

const count = z.number().int().nonnegative().safe();
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\\:\x00-\x1f]/.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Unsafe private allocation.",
  );
export const McpOutputSyncIntentSchema = McpOutputSyncFileSchema.extend({
  relativePath: relativePath.nullable(),
  desired: McpOutputSyncDigestSchema.nullable(),
})
  .strict()
  .refine(validIntent, "Invalid publication intent.");
export type McpOutputSyncIntent = z.infer<typeof McpOutputSyncIntentSchema>;
function validIntent(
  intent: z.infer<typeof McpOutputSyncFileSchema> & {
    relativePath: string | null;
    desired: z.infer<typeof McpOutputSyncDigestSchema> | null;
  },
) {
  const metadata = intent.role === "registry" || intent.role === "mirror";
  const cap = metadata
    ? MCP_OUTPUT_SYNC_LIMITS.mirrorBytes
    : MCP_OUTPUT_SYNC_LIMITS.imageBytes;
  return (
    (intent.previous?.bytes ?? 0) <= cap &&
    (intent.desired?.bytes ?? 0) <= cap &&
    validIntentAddress(intent) &&
    (intent.action === "publish"
      ? intent.desired !== null
      : intent.desired === null)
  );
}
function validIntentAddress(intent: {
  role: string;
  relativePath: string | null;
  pageId: string | null;
  action: string;
}) {
  const path =
    intent.role === "registry"
      ? intent.relativePath === null
      : intent.relativePath !== null;
  const page =
    intent.role === "registry" || intent.role === "mirror"
      ? intent.pageId === null && intent.action === "publish"
      : intent.pageId !== null;
  return path && page;
}
const admission = z
  .object({
    sequence: count.max(351),
    admittedAt: count,
    intent: McpOutputSyncIntentSchema,
    effect: McpOutputSyncEffectSchema.nullable(),
  })
  .strict()
  .refine(
    ({ intent, effect }) =>
      !effect ||
      (effect.fileId === intent.fileId &&
        effect.state ===
          (intent.action === "publish" ? "published" : "removed") &&
        effect.bytes === (intent.desired?.bytes ?? 0) &&
        effect.sha256 === (intent.desired?.sha256 ?? null)),
    "Effect differs from its admitted intent.",
  );
const retained = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    owner: McpOutputSyncIdSchema,
    jobId: z.string().uuid(),
    createdAt: count,
    expiresAt: count,
    request: McpSyncOutputSchema,
    signature: McpOutputSyncSnapshotSchema,
    review: McpOutputSyncPreflightSchema,
    reviewHash: McpOutputSyncSnapshotSchema,
    admissions: z.array(admission).max(352),
    result: McpOutputSyncResultSchema.nullable(),
    finishedAt: count.nullable(),
  })
  .strict();
type RecordShape = z.infer<typeof retained>;

/** Canonical path-free review, with every allocation owned by the selection. */
function validOutputSyncReview(review: McpOutputSyncPreflight): boolean {
  const ids = review.files.map((file) => file.fileId);
  return (
    sameOutputSyncValue(
      review.pages.map((page) => page.pageId),
      review.pageIds,
    ) &&
    new Set(ids).size === ids.length &&
    review.registryPublications.maximum === review.pageIds.length + 1 &&
    review.files.filter((file) => file.role === "mirror").length === 1 &&
    review.files.every((file) => validReviewedFile(file, review)) &&
    review.mirrorScope.chapters.some(
      (chapter) =>
        chapter.chapterId === review.chapterId &&
        chapter.connectionId === review.connectionId &&
        review.pageIds.every((pageId) => chapter.pageIds.includes(pageId)),
    ) &&
    review.pageIds.every((pageId) =>
      review.files.some(
        (file) =>
          file.pageId === pageId &&
          file.role === "result" &&
          file.action === "publish",
      ),
    )
  );
}
function validReviewedFile(
  file: McpOutputSyncFile,
  review: McpOutputSyncPreflight,
) {
  if (file.role === "registry") return false;
  if (file.role === "mirror")
    return (
      file.fileId === "mirror:publish" &&
      file.pageId === null &&
      file.action === "publish" &&
      (file.previous?.bytes ?? 0) <= MCP_OUTPUT_SYNC_LIMITS.mirrorBytes
    );
  return (
    file.pageId !== null &&
    review.pageIds.includes(file.pageId) &&
    file.fileId === `${file.role}:${file.pageId}:${file.action}`
  );
}
export function sameOutputSyncValue(left: unknown, right: unknown): boolean {
  // Hash is only an index binding. Exact canonical objects are compared as well.
  return JSON.stringify(left) === JSON.stringify(right);
}
export function outputSyncIntentMatchesReview(
  intent: McpOutputSyncIntent,
  review: McpOutputSyncPreflight,
) {
  if (intent.role === "registry") {
    const match = /^registry:(\d+):publish$/.exec(intent.fileId);
    return (
      match !== null &&
      Number(match[1]) < review.registryPublications.maximum &&
      String(Number(match[1])) === match[1]
    );
  }
  const expected = review.files.find((file) => file.fileId === intent.fileId);
  if (!expected) return false;
  const { relativePath: _path, desired: _desired, ...actual } = intent;
  return sameOutputSyncValue(expected, actual);
}
function validAdmissions(record: RecordShape) {
  const ids = record.admissions.map(({ intent }) => intent.fileId);
  const paths = record.admissions.flatMap(({ intent }) =>
    intent.relativePath === null ? [] : [intent.relativePath.toLowerCase()],
  );
  const registry = record.admissions.filter(
    ({ intent }) => intent.role === "registry",
  );
  const maximum =
    record.review.files.length + record.review.registryPublications.maximum;
  return (
    record.admissions.length <= maximum &&
    new Set(ids).size === ids.length &&
    new Set(paths).size === paths.length &&
    registry.every(
      (item, index) => item.intent.fileId === `registry:${index}:publish`,
    ) &&
    record.admissions.every(
      (item, index) =>
        item.sequence === index &&
        outputSyncIntentMatchesReview(item.intent, record.review) &&
        (index === record.admissions.length - 1 || item.effect !== null),
    ) &&
    record.admissions.reduce(
      (sum, item) => sum + (item.intent.desired?.bytes ?? 0),
      0,
    ) <= MCP_OUTPUT_SYNC_LIMITS.publishedBytes
  );
}
function sameEffect(
  file: McpOutputSyncResult["files"][number],
  effect: McpOutputSyncEffect,
) {
  return (
    file.state === effect.state &&
    file.bytes === effect.bytes &&
    file.sha256 === effect.sha256 &&
    file.completedAt === effect.completedAt
  );
}
function validUnadmittedFile(
  record: RecordShape,
  file: McpOutputSyncResult["files"][number],
) {
  return (
    file.role === "registry" &&
    file.pageId === null &&
    file.action === "publish" &&
    /^registry:(0|[1-9]\d*):publish$/.test(file.fileId) &&
    Number(file.fileId.split(":")[1]) <
      record.review.registryPublications.maximum &&
    (file.previous?.bytes ?? 0) <= MCP_OUTPUT_SYNC_LIMITS.mirrorBytes &&
    file.state === "planned" &&
    file.bytes === null &&
    file.sha256 === null &&
    file.completedAt === null
  );
}
function validResultFile(
  record: RecordShape,
  file: McpOutputSyncResult["files"][number],
) {
  const admitted = record.admissions.find(
    (item) => item.intent.fileId === file.fileId,
  );
  const known =
    admitted?.intent ??
    record.review.files.find((item) => item.fileId === file.fileId);
  if (!known) return validUnadmittedFile(record, file);
  const {
    state: _state,
    bytes: _bytes,
    sha256: _hash,
    completedAt: _time,
    ...identity
  } = file;
  const expected = {
    fileId: known.fileId,
    role: known.role,
    pageId: known.pageId,
    action: known.action,
    previous: known.previous,
  };
  if (!sameOutputSyncValue(identity, expected)) return false;
  if (admitted?.effect) return sameEffect(file, admitted.effect);
  return (
    ["planned", "failed", "publication_unconfirmed"].includes(file.state) &&
    (file.state !== "publication_unconfirmed" || admitted !== undefined) &&
    file.bytes === null &&
    file.sha256 === null &&
    file.completedAt === null
  );
}
function validCompletedResult(result: McpOutputSyncResult) {
  if (result.status !== "completed") return result.errorCode !== null;
  return (
    result.errorCode === null &&
    result.metadata === "published" &&
    result.mirror === "published" &&
    result.files.every(
      (file) => file.state === "published" || file.state === "removed",
    )
  );
}
function validResultStatus(result: McpOutputSyncResult) {
  const observed = result.files.some((file) =>
    ["published", "removed", "publication_unconfirmed"].includes(file.state),
  );
  if (result.status === "failed") return !observed;
  if (result.status === "partial") return observed;
  return true;
}
function validUnadmittedRegistry(
  record: RecordShape,
  result: McpOutputSyncResult,
) {
  const registry = record.admissions.filter(
    (item) => item.intent.role === "registry",
  );
  const known = new Set(registry.map((item) => item.intent.fileId));
  const unadmitted = result.files.filter(
    (file) => file.role === "registry" && !known.has(file.fileId),
  );
  return (
    unadmitted.length <= 1 &&
    unadmitted.every(
      (file) => file.fileId === `registry:${registry.length}:publish`,
    )
  );
}
function validOutputSyncResult(
  record: RecordShape,
  result: McpOutputSyncResult,
) {
  const ids = new Set(result.files.map((file) => file.fileId));
  const confirmed = record.admissions.reduce(
    (sum, item) => sum + (item.effect?.bytes ?? 0),
    0,
  );
  const pending = record.admissions
    .filter((item) => item.effect === null)
    .reduce((sum, item) => sum + (item.intent.desired?.bytes ?? 0), 0);
  const expected = outputSyncPublicationState(
    result.files,
    record.review.registryPublications.maximum,
  );
  return (
    ids.size === result.files.length &&
    record.review.files.every((file) => ids.has(file.fileId)) &&
    record.admissions.every((item) => ids.has(item.intent.fileId)) &&
    result.files.every((file) => validResultFile(record, file)) &&
    validResultStatus(result) &&
    validUnadmittedRegistry(record, result) &&
    (result.publishedBytes === confirmed ||
      result.publishedBytes === confirmed + pending) &&
    result.metadata === expected.metadata &&
    result.mirror === expected.mirror &&
    validCompletedResult(result)
  );
}
function validRequestBinding(record: RecordShape) {
  const {
    requestId: _id,
    confirm: _confirm,
    acknowledgePartialPublication: _partial,
    acknowledgeSavedTextMirror: _mirror,
    ...target
  } = record.request;
  const actual = {
    chapterId: record.review.chapterId,
    connectionId: record.review.connectionId,
    pageIds: record.review.pageIds,
    selectionSnapshot: record.review.selectionSnapshot,
    destinationSnapshot: record.review.destinationSnapshot,
    sourceSnapshot: record.review.sourceSnapshot,
  };
  return (
    sameOutputSyncValue(target, actual) &&
    record.signature === hashStableValue(record.request) &&
    record.reviewHash === hashStableValue(record.review)
  );
}
export const RetainedOutputSyncSchema = retained
  .refine(
    (record) => record.expiresAt === record.createdAt + 7 * 24 * 60 * 60 * 1000,
    "Invalid receipt lifetime.",
  )
  .refine(
    (record) =>
      validOutputSyncReview(record.review) && validRequestBinding(record),
    "Receipt does not match its reviewed request.",
  )
  .refine(validAdmissions, "Invalid publication admissions.")
  .refine(
    (record) => (record.result === null) === (record.finishedAt === null),
    "Incomplete terminal receipt.",
  )
  .refine(
    (record) =>
      record.result === null || validOutputSyncResult(record, record.result),
    "Terminal receipt differs from its durable effects.",
  );
export type RetainedOutputSync = z.infer<typeof RetainedOutputSyncSchema>;
