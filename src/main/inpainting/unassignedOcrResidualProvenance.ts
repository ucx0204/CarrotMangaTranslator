/* eslint-disable max-lines -- the sealed OCR/font/source provenance verifier is kept as one auditable contract. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { PixelRect } from "./maskGeometry";
import type { SourceGlyphEvidence } from "./sourceGlyphResidual";
import {
  UNASSIGNED_OCR_RESIDUAL_PROVENANCE_CONTRACT_VERSION,
  type RawOcrGlyphHint,
  type UnassignedOcrResidualProvenanceInput,
  type UnassignedOcrResidualProvenanceReceipt,
} from "./sourceGlyphResidualDiagnosticTypes";
import {
  hashSourceGlyphEvidence,
  verifyPatternSourceGlyphEvidenceReceipt,
} from "./sourceGlyphEvidenceReceipt";

const OCR_RESULT_SCHEMA_VERSION = 10;
const FONT_INPUT_SCHEMA_VERSION = 1;

export type ResolvedUnassignedOcrProvenance = {
  assignedHintIds: ReadonlySet<string>;
  hints: readonly RawOcrGlyphHint[];
  knownBlockBounds: readonly PixelRect[];
  knownSourceEvidence: readonly SourceGlyphEvidence[];
  receipt: UnassignedOcrResidualProvenanceReceipt;
};

export function resolveUnassignedOcrProvenance(options: {
  after: Buffer;
  assignedHintIds?: ReadonlySet<string>;
  before: Buffer;
  hints?: readonly RawOcrGlyphHint[];
  knownBlockBounds?: readonly PixelRect[];
  knownSourceEvidence?: readonly SourceGlyphEvidence[];
  pageHeight: number;
  pageWidth: number;
  provenance?: UnassignedOcrResidualProvenanceInput;
}): ResolvedUnassignedOcrProvenance {
  if (
    options.provenance &&
    (options.assignedHintIds !== undefined ||
      options.hints !== undefined ||
      options.knownBlockBounds !== undefined ||
      options.knownSourceEvidence !== undefined)
  ) {
    throw new Error(
      "Sealed OCR provenance cannot be mixed with caller-supplied hints.",
    );
  }
  if (!options.provenance) {
    return buildUnsealedLegacyProvenance(
      options.assignedHintIds ?? new Set(),
      options.hints ?? [],
      options.knownBlockBounds ?? [],
      options.knownSourceEvidence ?? [],
    );
  }
  return verifySealedProvenance(options.provenance, options);
}

function verifySealedProvenance(
  input: UnassignedOcrResidualProvenanceInput,
  dimensions: {
    after: Buffer;
    before: Buffer;
    pageHeight: number;
    pageWidth: number;
  },
): ResolvedUnassignedOcrProvenance {
  const sourceSha256 = verifyExpectedSha(
    input.sourceImageBytes,
    input.expectedSourceImageSha256,
    "source image",
  );
  const ocrSha256 = verifyExpectedSha(
    input.ocrResultBytes,
    input.expectedOcrResultSha256,
    "OCR result",
  );
  const fontSha256 = verifyExpectedSha(
    input.fontInputBytes,
    input.expectedFontInputSha256,
    "font input",
  );
  const ocr = parseJsonRecord(input.ocrResultBytes, "OCR result");
  const font = parseJsonRecord(input.fontInputBytes, "font input");
  assertInputBindings({
    before: dimensions.before,
    after: dimensions.after,
    dimensions,
    font,
    input,
    ocr,
    sourceSha256,
  });
  const hints = parseRawHints(ocr.hints);
  const membership = collectCandidateMembership(
    font.requestBlocks,
    recordValue(font.page).blocks,
  );
  const knownEvidence = resolveKnownEvidence({
    height: dimensions.pageHeight,
    knownSourceEvidenceByBlockId: input.knownSourceEvidenceByBlockId,
    pageBlocks: recordValue(font.page).blocks,
    receipt: input.sourceEvidenceReceipt,
    width: dimensions.pageWidth,
  });
  const hintIds = new Set(hints.map((hint) => String(hint.id)));
  for (const candidateId of membership.assignedIds) {
    if (!hintIds.has(candidateId)) {
      throw new Error(
        `Assigned OCR candidate is absent from sealed result: ${candidateId}`,
      );
    }
  }
  const receipt = sealReceipt({
    assignedCandidateIds: [...membership.assignedIds].sort(compareIds),
    candidateMembership: membership.rows,
    fontInputSha256: fontSha256,
    input,
    ocrResultSha256: ocrSha256,
    sourceImageSha256: sourceSha256,
  });
  return {
    assignedHintIds: membership.assignedIds,
    hints,
    knownBlockBounds: knownEvidence.bounds,
    knownSourceEvidence: knownEvidence.evidence,
    receipt,
  };
}

// eslint-disable-next-line complexity -- the immutable OCR/font/source cross-binding must fail as one atomic gate.
function assertInputBindings(options: {
  after: Buffer;
  before: Buffer;
  dimensions: { pageHeight: number; pageWidth: number };
  font: Record<string, unknown>;
  input: UnassignedOcrResidualProvenanceInput;
  ocr: Record<string, unknown>;
  sourceSha256: string;
}): void {
  const { after, before, dimensions, font, input, ocr, sourceSha256 } = options;
  const fontPage = recordValue(font.page);
  const sourceReceipt = input.sourceEvidenceReceipt;
  const sourceReceiptVerification =
    verifyPatternSourceGlyphEvidenceReceipt(sourceReceipt);
  if (
    !sourceReceiptVerification.valid ||
    sourceReceipt.pageId !== input.sourcePageId ||
    sourceReceipt.source.assetSha256 !== sourceSha256 ||
    resolve(sourceReceipt.source.assetPath) !==
      resolve(input.sourceImagePath) ||
    sourceReceipt.source.width !== dimensions.pageWidth ||
    sourceReceipt.source.height !== dimensions.pageHeight ||
    sourceReceipt.source.bitmapSha256 !== sha256(before) ||
    sourceReceipt.after.bitmapSha256 !== sha256(after) ||
    ocr.schemaVersion !== OCR_RESULT_SCHEMA_VERSION ||
    font.schemaVersion !== FONT_INPUT_SCHEMA_VERSION ||
    font.sourcePageId !== input.sourcePageId ||
    font.sourcePageSha256 !== sourceSha256 ||
    fontPage.id !== input.sourcePageId ||
    resolveString(fontPage.imagePath) !== resolve(input.sourceImagePath) ||
    resolveString(ocr.imagePath) !== resolve(input.sourceImagePath) ||
    ocr.width !== dimensions.pageWidth ||
    ocr.height !== dimensions.pageHeight ||
    fontPage.width !== dimensions.pageWidth ||
    fontPage.height !== dimensions.pageHeight
  ) {
    throw new Error("OCR/font/source provenance binding mismatch.");
  }
}

function collectCandidateMembership(
  value: unknown,
  pageBlocksValue: unknown,
): {
  assignedIds: Set<string>;
  rows: CandidateMembershipRow[];
} {
  if (!Array.isArray(value)) {
    throw new Error("Sealed font input is missing requestBlocks.");
  }
  const assignedIds = new Set<string>();
  const seenBlockIds = new Set<string>();
  const rows = value.map((rawBlock) => {
    const block = recordValue(rawBlock);
    const item = recordValue(block.item);
    const direction = recordValue(block.sourceGeometryDirection);
    const membership = recordValue(direction.candidateMembership);
    const blockId = requiredString(block.blockId, "font request blockId");
    if (seenBlockIds.has(blockId)) {
      throw new Error(`Duplicate sealed font request block: ${blockId}`);
    }
    seenBlockIds.add(blockId);
    const itemCandidateIds = candidateIds(item.candidateIds);
    const originalCandidateIds = candidateIds(membership.originalCandidateIds);
    const voterCandidateIds = candidateIds(membership.voterCandidateIds);
    const directionCandidateIds = candidateIds(direction.candidateIds);
    assertCandidateMembership({
      blockId,
      direction,
      directionCandidateIds,
      item,
      itemCandidateIds,
      membership,
      originalCandidateIds,
      voterCandidateIds,
    });
    for (const candidateId of originalCandidateIds) {
      assignedIds.add(candidateId);
    }
    return {
      blockId,
      itemCandidateIds,
      originalCandidateIds,
      voterCandidateIds,
      membershipContractVersion: requiredString(
        membership.contractVersion,
        "candidate membership contract",
      ),
      membershipBindingId: requiredString(
        membership.bindingId,
        "candidate membership bindingId",
      ),
      membershipSource: requiredString(
        membership.source,
        "candidate membership source",
      ),
    };
  });
  rows.sort((left, right) => left.blockId.localeCompare(right.blockId));
  assertPageBlockInventory(
    pageBlocksValue,
    rows.map((row) => row.blockId),
  );
  return { assignedIds, rows };
}

type CandidateMembershipRow = {
  blockId: string;
  itemCandidateIds: string[];
  originalCandidateIds: string[];
  voterCandidateIds: string[];
  membershipContractVersion: string;
  membershipBindingId: string;
  membershipSource: string;
};

function assertCandidateMembership(options: {
  blockId: string;
  direction: Record<string, unknown>;
  directionCandidateIds: string[];
  item: Record<string, unknown>;
  itemCandidateIds: string[];
  membership: Record<string, unknown>;
  originalCandidateIds: string[];
  voterCandidateIds: string[];
}): void {
  const allowedSources = new Set([
    "semantic_ocr_fixed_block_request_v5",
    "semantic_ocr_fixed_block_request_v6",
    "sealed_font_input_request_block_v2",
  ]);
  if (
    options.membership.contractVersion !==
      "font-matching-ocr-candidate-membership-v2" ||
    !allowedSources.has(String(options.membership.source)) ||
    options.direction.contractVersion !==
      "font-matching-ocr-geometry-direction-v2" ||
    options.direction.source !== "semantic_ocr_candidate_bbox_majority" ||
    !sameIds(options.itemCandidateIds, options.originalCandidateIds) ||
    !sameIds(options.directionCandidateIds, options.voterCandidateIds) ||
    !isOrderedSubset(options.voterCandidateIds, options.originalCandidateIds)
  ) {
    throw new Error(`Invalid sealed candidate membership: ${options.blockId}`);
  }
  if (
    options.item.sourceCandidateMembership !== undefined &&
    !sameMembership(
      recordValue(options.item.sourceCandidateMembership),
      options.membership,
    )
  ) {
    throw new Error(
      `Conflicting sealed candidate membership: ${options.blockId}`,
    );
  }
}

function assertPageBlockInventory(
  value: unknown,
  requestBlockIds: string[],
): void {
  if (!Array.isArray(value)) {
    throw new Error("Sealed font page is missing blocks.");
  }
  const pageBlockIds = value
    .map((block) => requiredString(recordValue(block).id, "font page block id"))
    .sort();
  const expected = [...requestBlockIds].sort();
  if (
    new Set(pageBlockIds).size !== pageBlockIds.length ||
    !sameIds(pageBlockIds, expected)
  ) {
    throw new Error("Sealed font page/request block inventory mismatch.");
  }
}

function resolveKnownEvidence(options: {
  height: number;
  knownSourceEvidenceByBlockId?: ReadonlyMap<string, SourceGlyphEvidence>;
  pageBlocks: unknown;
  receipt: UnassignedOcrResidualProvenanceInput["sourceEvidenceReceipt"];
  width: number;
}): { bounds: PixelRect[]; evidence: SourceGlyphEvidence[] } {
  if (!Array.isArray(options.pageBlocks)) {
    throw new Error("Sealed font page is missing known blocks.");
  }
  if (!options.knownSourceEvidenceByBlockId) {
    throw new Error("Known source evidence block map is missing.");
  }
  const blocks = options.pageBlocks.map((value) => recordValue(value));
  const blockIds = blocks
    .map((block) => requiredString(block.id, "known block id"))
    .sort();
  const receiptIds = Object.keys(options.receipt.blocksById).sort();
  const evidenceIds = [...options.knownSourceEvidenceByBlockId.keys()].sort();
  if (!sameIds(blockIds, receiptIds) || !sameIds(blockIds, evidenceIds)) {
    throw new Error("Known source evidence block inventory mismatch.");
  }
  const evidence = blockIds.map((blockId) => {
    const item = options.knownSourceEvidenceByBlockId?.get(blockId);
    const binding = options.receipt.blocksById[blockId];
    if (!item || !binding) {
      throw new Error(`Known source evidence binding missing: ${blockId}`);
    }
    if (hashSourceGlyphEvidence(item) !== binding.sourceEvidenceSha256) {
      throw new Error(`Known source evidence hash mismatch: ${blockId}`);
    }
    return item;
  });
  const blocksById = new Map(
    blocks.map((block) => [requiredString(block.id, "known block id"), block]),
  );
  return {
    bounds: blockIds.map((blockId) =>
      parseKnownBlockBounds(
        blocksById.get(blockId),
        options.width,
        options.height,
      ),
    ),
    evidence,
  };
}

function parseKnownBlockBounds(
  block: Record<string, unknown> | undefined,
  width: number,
  height: number,
): PixelRect {
  const bbox = recordValue(block?.bbox);
  const scaleX = block?.bboxSpace === "pixels" ? 1 : width / 1_000;
  const scaleY = block?.bboxSpace === "pixels" ? 1 : height / 1_000;
  const x1 = clamp(Math.floor(Number(bbox.x) * scaleX), 0, width);
  const y1 = clamp(Math.floor(Number(bbox.y) * scaleY), 0, height);
  const x2 = clamp(
    Math.ceil((Number(bbox.x) + Number(bbox.w)) * scaleX),
    0,
    width,
  );
  const y2 = clamp(
    Math.ceil((Number(bbox.y) + Number(bbox.h)) * scaleY),
    0,
    height,
  );
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) {
    throw new Error("Known font block bbox is invalid.");
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function sealReceipt(options: {
  assignedCandidateIds: string[];
  candidateMembership: CandidateMembershipRow[];
  fontInputSha256: string;
  input: UnassignedOcrResidualProvenanceInput;
  ocrResultSha256: string;
  sourceImageSha256: string;
}): UnassignedOcrResidualProvenanceReceipt {
  const receiptWithoutBinding = {
    contractVersion: UNASSIGNED_OCR_RESIDUAL_PROVENANCE_CONTRACT_VERSION,
    sealed: true,
    rejectionReasons: [] as string[],
    sourceImagePath: resolve(options.input.sourceImagePath),
    sourcePageId: options.input.sourcePageId,
    sourceImageSha256: options.sourceImageSha256,
    sourceImageSchema: "raw-source-image-bytes-v1" as const,
    sourceBitmapSha256: options.input.sourceEvidenceReceipt.source.bitmapSha256,
    sourceDecoderContract: options.input.sourceEvidenceReceipt.decoderContract,
    sourceEvidenceBindingSha256:
      options.input.sourceEvidenceReceipt.bindingSha256,
    ocrResultSha256: options.ocrResultSha256,
    ocrResultSchemaVersion: OCR_RESULT_SCHEMA_VERSION,
    fontInputSha256: options.fontInputSha256,
    fontInputSchemaVersion: FONT_INPUT_SCHEMA_VERSION,
    assignedCandidateIds: options.assignedCandidateIds,
    assignedCandidateIdsSha256: sha256Canonical(options.assignedCandidateIds),
    candidateMembershipSha256: sha256Canonical(options.candidateMembership),
  };
  return {
    ...receiptWithoutBinding,
    bindingSha256: sha256Canonical(receiptWithoutBinding),
  };
}

function buildUnsealedLegacyProvenance(
  assignedHintIds: ReadonlySet<string>,
  hints: readonly RawOcrGlyphHint[],
  knownBlockBounds: readonly PixelRect[],
  knownSourceEvidence: readonly SourceGlyphEvidence[],
): ResolvedUnassignedOcrProvenance {
  const assignedCandidateIds = [...assignedHintIds]
    .map(String)
    .sort(compareIds);
  const receiptWithoutBinding = {
    contractVersion: UNASSIGNED_OCR_RESIDUAL_PROVENANCE_CONTRACT_VERSION,
    sealed: false,
    rejectionReasons: ["unsealed-ocr-provenance"],
    sourceImagePath: null,
    sourcePageId: null,
    sourceImageSha256: null,
    sourceImageSchema: "raw-source-image-bytes-v1" as const,
    sourceBitmapSha256: null,
    sourceDecoderContract: null,
    sourceEvidenceBindingSha256: null,
    ocrResultSha256: null,
    ocrResultSchemaVersion: null,
    fontInputSha256: null,
    fontInputSchemaVersion: null,
    assignedCandidateIds,
    assignedCandidateIdsSha256: sha256Canonical(assignedCandidateIds),
    candidateMembershipSha256: sha256Canonical(null),
  };
  return {
    assignedHintIds: new Set(assignedCandidateIds),
    hints,
    knownBlockBounds,
    knownSourceEvidence,
    receipt: {
      ...receiptWithoutBinding,
      bindingSha256: sha256Canonical(receiptWithoutBinding),
    },
  };
}

function verifyExpectedSha(
  bytes: Uint8Array,
  expected: string,
  label: string,
): string {
  const actual = sha256(bytes);
  if (!/^[a-f0-9]{64}$/u.test(expected) || actual !== expected) {
    throw new Error(`Sealed ${label} SHA-256 mismatch.`);
  }
  return actual;
}

function parseRawHints(value: unknown): RawOcrGlyphHint[] {
  if (!Array.isArray(value)) {
    throw new Error("Sealed OCR result is missing hints.");
  }
  const hints = value as RawOcrGlyphHint[];
  const ids = hints.map((hint) => String(hint?.id ?? "").trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Sealed OCR hint identities are invalid.");
  }
  return hints;
}

function candidateIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => Number.isInteger(item) && Number(item) > 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Candidate id inventory is invalid.");
  }
  return value.map(String);
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((candidateId, index) => candidateId === right[index])
  );
}

function isOrderedSubset(values: string[], inventory: string[]): boolean {
  let cursor = 0;
  for (const candidateId of inventory) {
    if (candidateId === values[cursor]) cursor += 1;
  }
  return cursor === values.length;
}

function sameMembership(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return (
    left.contractVersion === right.contractVersion &&
    left.source === right.source &&
    left.bindingId === right.bindingId &&
    JSON.stringify(left.originalCandidateIds) ===
      JSON.stringify(right.originalCandidateIds) &&
    JSON.stringify(left.voterCandidateIds) ===
      JSON.stringify(right.voterCandidateIds)
  );
}

function parseJsonRecord(bytes: Uint8Array, label: string) {
  try {
    return recordValue(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    throw new Error(`Invalid sealed ${label} JSON.`, { cause: error });
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a sealed provenance object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Invalid ${label}.`);
  return result;
}

function resolveString(value: unknown): string {
  return resolve(requiredString(value, "source image path"));
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return sha256(Buffer.from(stableStringify(value)));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
