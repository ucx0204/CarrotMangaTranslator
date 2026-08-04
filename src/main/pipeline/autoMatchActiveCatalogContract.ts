import { createHash } from "node:crypto";
import {
  FONT_MATCHING_ACTIVE_CATALOG_RECORD,
  FONT_MATCHING_ACTIVE_CATALOG_SCHEMA,
} from "./fontMatchingRuntimeArtifactContract";
import type {
  AutoMatchActiveCandidate,
  AutoMatchActiveCatalog,
  AutoMatchCandidateDisposition,
  AutoMatchFontAssetDescriptor,
} from "./autoMatchActiveCatalogTypes";

const TERMINAL_CATALOG_ACTIONS = [
  "retained_unique_p1",
  "deleted_redundant",
  "deleted_safe_zero",
] as const;

export function parseAutoMatchActiveCatalog(
  value: unknown,
): AutoMatchActiveCatalog | null {
  if (!isActiveCatalogEnvelope(value)) return null;
  const catalogVersion = nonEmptyText(value.catalog_version);
  const candidateIds = stringArray(value.candidate_ids);
  const candidateOrder = nonEmptyText(value.candidate_order_sha256);
  const candidates = candidateArray(value.candidates, true);
  const excludedCandidates = candidateArray(value.excluded_candidates, false);
  const sourceRecords = parseSourceRecords(value.source_records);
  if (
    !catalogVersion ||
    !candidateIds ||
    !candidateOrder ||
    !validCatalogHeader(value, candidateIds, candidateOrder) ||
    !candidates ||
    !excludedCandidates ||
    !sourceRecords
  ) {
    return null;
  }
  if (!validCandidateInventory(candidateIds, candidates, excludedCandidates)) {
    return null;
  }
  return {
    catalogVersion,
    locale: "ko",
    candidateIds,
    candidateOrderSha256: candidateOrder,
    candidates,
    excludedCandidates,
    recordSha256: String(value.record_sha256),
    sourceRecords,
  };
}

export function candidateOrderSha256(candidateIds: readonly string[]): string {
  return createHash("sha256")
    .update(`${candidateIds.join("\n")}\n`, "utf8")
    .digest("hex");
}

function isActiveCatalogEnvelope(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    isRecord(value) &&
    validRecordSeal(value) &&
    value.schema_version === FONT_MATCHING_ACTIVE_CATALOG_SCHEMA &&
    value.record_type === FONT_MATCHING_ACTIVE_CATALOG_RECORD,
  );
}

function validCatalogHeader(
  value: Record<string, unknown>,
  candidateIds: readonly string[],
  candidateOrder: string,
): boolean {
  return Boolean(
    value.locale === "ko" &&
    candidateIds.length > 0 &&
    new Set(candidateIds).size === candidateIds.length &&
    value.candidate_count === candidateIds.length &&
    candidateOrder === candidateOrderSha256(candidateIds),
  );
}

function validCandidateInventory(
  candidateIds: readonly string[],
  candidates: readonly AutoMatchActiveCandidate[],
  excludedCandidates: readonly AutoMatchActiveCandidate[],
): boolean {
  if (
    !sameOrder(
      candidates.map(({ candidateId }) => candidateId),
      candidateIds,
    )
  ) {
    return false;
  }
  const excludedIds = excludedCandidates.map(({ candidateId }) => candidateId);
  return (
    new Set(excludedIds).size === excludedIds.length &&
    excludedIds.every((candidateId) => !candidateIds.includes(candidateId))
  );
}

function candidateArray(
  value: unknown,
  active: boolean,
): readonly AutoMatchActiveCandidate[] | null {
  if (!Array.isArray(value)) return null;
  const candidates = value.map((entry) => parseCandidate(entry, active));
  return candidates.every(isPresent) ? candidates : null;
}

function parseCandidate(
  value: unknown,
  active: boolean,
): AutoMatchActiveCandidate | null {
  if (!isCandidateEnvelope(value, active)) return null;
  const candidateId = nonEmptyText(value.candidate_id);
  const disposition = parseDisposition(value.disposition, active);
  const assets = active ? parseAssets(value.assets) : [];
  if (!candidateId || !disposition || !assets) return null;
  if (active && assets.length === 0) return null;
  if (!uniqueAssetInventory(assets)) return null;
  return { candidateId, assets, disposition };
}

function isCandidateEnvelope(
  value: unknown,
  active: boolean,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const expected = active
    ? ["assets", "candidate_id", "disposition"]
    : ["candidate_id", "disposition"];
  return hasExactKeys(value, expected);
}

function parseAssets(value: unknown): AutoMatchFontAssetDescriptor[] | null {
  if (!Array.isArray(value)) return null;
  const assets = value.map(parseAsset);
  return assets.every(isPresent) ? assets : null;
}

function uniqueAssetInventory(
  assets: readonly AutoMatchFontAssetDescriptor[],
): boolean {
  const faceIds = assets.map(({ faceId }) => faceId);
  const files = assets.map(({ file }) => file);
  return (
    new Set(faceIds).size === faceIds.length &&
    new Set(files).size === files.length
  );
}

function parseAsset(value: unknown): AutoMatchFontAssetDescriptor | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ["byte_size", "face_id", "file", "sha256"])) {
    return null;
  }
  const faceId = nonEmptyText(value.face_id);
  const file = nonEmptyText(value.file);
  if (!faceId || !file || file.startsWith("/") || file.includes("..")) {
    return null;
  }
  if (!positiveInteger(value.byte_size) || !isSha256(value.sha256)) return null;
  return {
    faceId,
    file: file.replaceAll("\\", "/"),
    byteSize: value.byte_size,
    sha256: value.sha256,
  };
}

function parseDisposition(
  value: unknown,
  active: boolean,
): AutoMatchCandidateDisposition | null {
  if (!isDispositionEnvelope(value, active)) return null;
  const fields = dispositionFields(value);
  if (!fields) return null;
  if (!validDisposition(fields, active)) return null;
  return {
    ...fields,
    activeReleaseEligible: active,
    allUnrenderable: false,
    terminal: true,
  };
}

function isDispositionEnvelope(
  value: unknown,
  active: boolean,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, dispositionKeys)) return false;
  return (
    value.active_release_eligible === active &&
    value.all_unrenderable === false &&
    value.terminal === true
  );
}

const dispositionKeys = [
  "action",
  "active_release_eligible",
  "all_unrenderable",
  "deployable_opportunity_count",
  "evidence_source",
  "safe_count",
  "terminal",
];

function dispositionFields(
  value: Record<string, unknown>,
): Pick<
  AutoMatchCandidateDisposition,
  "action" | "deployableOpportunityCount" | "evidenceSource" | "safeCount"
> | null {
  const action = nonEmptyText(value.action);
  const evidenceSource = nonEmptyText(value.evidence_source);
  const safeCount = nullableNonNegativeInteger(value.safe_count);
  const deployableOpportunityCount = nullablePositiveInteger(
    value.deployable_opportunity_count,
  );
  if (!action || safeCount === undefined) return null;
  if (deployableOpportunityCount === undefined) return null;
  if (!isEvidenceSource(evidenceSource)) return null;
  return { action, evidenceSource, safeCount, deployableOpportunityCount };
}

function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  return value === null ? null : nonNegativeInteger(value) ? value : undefined;
}

function nullablePositiveInteger(value: unknown): number | null | undefined {
  return value === null ? null : positiveInteger(value) ? value : undefined;
}

function isEvidenceSource(
  value: string | null,
): value is AutoMatchCandidateDisposition["evidenceSource"] {
  return (
    value === "prior_production_catalog" || value === "v5_catalog_disposition"
  );
}

function validDisposition(
  fields: ReturnType<typeof dispositionFields> & {},
  active: boolean,
): boolean {
  return fields.evidenceSource === "prior_production_catalog"
    ? validPriorDisposition(fields, active)
    : validV5Disposition(fields, active);
}

function validPriorDisposition(
  fields: ReturnType<typeof dispositionFields> & {},
  active: boolean,
): boolean {
  return (
    active &&
    fields.action === "prior_production_catalog" &&
    fields.safeCount === null &&
    fields.deployableOpportunityCount === null
  );
}

function validV5Disposition(
  fields: ReturnType<typeof dispositionFields> & {},
  active: boolean,
): boolean {
  if (!TERMINAL_CATALOG_ACTIONS.includes(fields.action as never)) return false;
  if (fields.safeCount === null || fields.deployableOpportunityCount === null) {
    return false;
  }
  if (active !== (fields.action === "retained_unique_p1")) return false;
  return fields.action === "deleted_safe_zero"
    ? fields.safeCount === 0
    : fields.safeCount > 0;
}

function parseSourceRecords(
  value: unknown,
): AutoMatchActiveCatalog["sourceRecords"] | null {
  if (!isRecord(value) || !hasExactKeys(value, sourceRecordKeys)) return null;
  if (!sourceRecordKeys.every((key) => isSha256(value[key]))) return null;
  return {
    catalogDispositionRecordSha256:
      value.catalog_disposition_record_sha256 as string,
    deploymentFontFaceManifestSha256:
      value.deployment_font_face_manifest_sha256 as string,
    deploymentRenderBankManifestSha256:
      value.deployment_render_bank_manifest_sha256 as string,
    evidenceFontFaceManifestSha256:
      value.evidence_font_face_manifest_sha256 as string,
    evidenceRenderBankManifestSha256:
      value.evidence_render_bank_manifest_sha256 as string,
    finalCatalogRecordSha256: value.final_catalog_record_sha256 as string,
  };
}

const sourceRecordKeys = [
  "catalog_disposition_record_sha256",
  "deployment_font_face_manifest_sha256",
  "deployment_render_bank_manifest_sha256",
  "evidence_font_face_manifest_sha256",
  "evidence_render_bank_manifest_sha256",
  "final_catalog_record_sha256",
];

function validRecordSeal(record: Record<string, unknown>): boolean {
  if (!isSha256(record.record_sha256)) return false;
  const core = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "record_sha256"),
  );
  return record.record_sha256 === sha256(canonicalJson(core));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return sameOrder(Object.keys(value).sort(), [...expected].sort());
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => nonEmptyText(entry))
    ? value.map(String)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
