/* eslint-disable max-lines -- immutable evidence receipt production and verification stay in one auditable contract. */
import { createHash } from "node:crypto";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PatternMaskContext } from "./patternPageMask";
import {
  SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION,
  type SourceGlyphEvidence,
} from "./sourceGlyphResidual";

const SOURCE_GLYPH_EVIDENCE_RECEIPT_CONTRACT_VERSION =
  "source-glyph-evidence-receipt-v1" as const;
const SOURCE_GLYPH_EVIDENCE_DECODER_CONTRACT =
  "electron-native-image-bgra8-v1" as const;

export type PatternBitmapBaseline = {
  assetPath: string;
  assetSha256: string | null;
  bitmap: Buffer;
  bitmapSha256: string;
  height: number;
  width: number;
};

export type PatternSourceGlyphEvidenceReceipt = {
  contractVersion: typeof SOURCE_GLYPH_EVIDENCE_RECEIPT_CONTRACT_VERSION;
  diagnosticOnly: true;
  promotionEligible: false;
  resolutionNormalized: false;
  sealed: boolean;
  sealingErrors: string[];
  decoderContract: typeof SOURCE_GLYPH_EVIDENCE_DECODER_CONTRACT;
  sourceEvidenceProfileContract: "pattern-text-mask-zero-dilation-v1";
  residualProfileContract: typeof SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION;
  pageId: string;
  source: Omit<PatternBitmapBaseline, "bitmap"> & {
    baselineKind: "immutable-original";
  };
  before: Omit<PatternBitmapBaseline, "bitmap"> & {
    baselineKind: "immutable-original" | "retry-cleaned";
  };
  after: {
    baselineKind: "cleaned-output-bitmap";
    bitmapSha256: string;
    cleanedAssetPath: string | null;
    cleanedAssetSha256: string | null;
  };
  blocksById: Record<
    string,
    {
      blockId: string;
      firstPassCoreBounds: InpaintingWindowMask["bounds"];
      firstPassCoreSha256: string;
      sourceEvidenceBounds: InpaintingWindowMask["bounds"];
      sourceEvidenceSha256: string;
      sourceEvidenceStrategy: SourceGlyphEvidence["strategy"];
      sourceAssetSha256: string | null;
      sourceBitmapSha256: string;
    }
  >;
  blockIdsSha256: string;
  bindingSha256: string;
};

export function createPatternBitmapBaseline(options: {
  assetPath: string;
  assetBytes: Uint8Array | null;
  bitmap: Buffer;
  height: number;
  width: number;
}): PatternBitmapBaseline {
  if (
    !options.assetPath ||
    !Number.isInteger(options.width) ||
    !Number.isInteger(options.height) ||
    options.width <= 0 ||
    options.height <= 0 ||
    options.bitmap.length !== options.width * options.height * 4
  ) {
    throw new Error("Invalid pattern bitmap baseline contract.");
  }
  return {
    assetPath: options.assetPath,
    assetSha256: options.assetBytes ? sha256(options.assetBytes) : null,
    bitmap: Buffer.from(options.bitmap),
    bitmapSha256: sha256(options.bitmap),
    height: options.height,
    width: options.width,
  };
}

export function buildPatternSourceGlyphEvidenceReceipt(options: {
  afterBitmap: Buffer;
  before: PatternBitmapBaseline;
  cleanedAssetBytes?: Uint8Array;
  cleanedAssetPath?: string;
  expectedBlockIds: readonly string[];
  pageId: string;
  source: PatternBitmapBaseline;
  validationBindingsByBlockId: PatternMaskContext["validationBindingsByBlockId"];
}): PatternSourceGlyphEvidenceReceipt {
  const blockEntries = [...options.validationBindingsByBlockId.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const blocksById = Object.fromEntries(
    blockEntries.map(([blockId, binding]) => {
      if (blockId !== binding.blockId) {
        throw new Error("Source evidence block-key binding mismatch.");
      }
      return [
        blockId,
        {
          blockId,
          firstPassCoreBounds: { ...binding.firstPassCore.bounds },
          firstPassCoreSha256: hashWindowMask(binding.firstPassCore),
          sourceEvidenceBounds: {
            ...binding.sourceGlyphEvidence.windowMask.bounds,
          },
          sourceEvidenceSha256: hashSourceGlyphEvidence(
            binding.sourceGlyphEvidence,
          ),
          sourceEvidenceStrategy: binding.sourceGlyphEvidence.strategy,
          sourceAssetSha256: options.source.assetSha256,
          sourceBitmapSha256: options.source.bitmapSha256,
        },
      ];
    }),
  );
  const sealingErrors = resolveSealingErrors(options, blockEntries.length);
  const receiptWithoutBinding = {
    contractVersion: SOURCE_GLYPH_EVIDENCE_RECEIPT_CONTRACT_VERSION,
    diagnosticOnly: true as const,
    promotionEligible: false as const,
    resolutionNormalized: false as const,
    sealed: sealingErrors.length === 0,
    sealingErrors,
    decoderContract: SOURCE_GLYPH_EVIDENCE_DECODER_CONTRACT,
    sourceEvidenceProfileContract:
      "pattern-text-mask-zero-dilation-v1" as const,
    residualProfileContract: SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION,
    pageId: options.pageId,
    source: {
      ...withoutBitmap(options.source),
      baselineKind: "immutable-original" as const,
    },
    before: {
      ...withoutBitmap(options.before),
      baselineKind:
        options.before.assetPath === options.source.assetPath
          ? ("immutable-original" as const)
          : ("retry-cleaned" as const),
    },
    after: {
      baselineKind: "cleaned-output-bitmap" as const,
      bitmapSha256: sha256(options.afterBitmap),
      cleanedAssetPath: options.cleanedAssetPath ?? null,
      cleanedAssetSha256: options.cleanedAssetBytes
        ? sha256(options.cleanedAssetBytes)
        : null,
    },
    blocksById,
    blockIdsSha256: sha256Canonical(blockEntries.map(([blockId]) => blockId)),
  };
  return {
    ...receiptWithoutBinding,
    bindingSha256: sha256Canonical(receiptWithoutBinding),
  };
}

function hashWindowMask(mask: InpaintingWindowMask): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      contract: "inpainting-window-mask-v1",
      bounds: mask.bounds,
      length: mask.data.length,
    }),
  );
  hash.update(Buffer.from(mask.data));
  return hash.digest("hex");
}

export function assertPatternValidationBindings(
  mask: PatternMaskContext,
): void {
  const blockCount = mask.validationBlockIds.length;
  if (mask.validationWindowMasks.length !== blockCount) {
    throw new Error("Inpainting validation mask ownership is incomplete.");
  }
  if (mask.sourceGlyphEvidence.length !== blockCount) {
    throw new Error(
      "Source-glyph validation evidence ownership is incomplete.",
    );
  }
  if (mask.validationBindingsByBlockId.size !== blockCount) {
    throw new Error("Source-glyph keyed evidence ownership is incomplete.");
  }
  if (new Set(mask.validationBlockIds).size !== blockCount) {
    throw new Error("Source-glyph keyed evidence contains duplicate blocks.");
  }
  for (let index = 0; index < blockCount; index += 1) {
    assertPatternValidationBinding(mask, index);
  }
}

// eslint-disable-next-line complexity -- receipt verification keeps all immutable evidence checks in one fail-closed boundary.
export function verifyPatternSourceGlyphEvidenceReceipt(value: unknown): {
  valid: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reasons: ["receipt-object-invalid"] };
  }
  const receipt = value as Record<string, unknown>;
  const source = objectValue(receipt.source);
  const before = objectValue(receipt.before);
  const after = objectValue(receipt.after);
  const blocks = objectValue(receipt.blocksById);
  if (
    receipt.contractVersion !== SOURCE_GLYPH_EVIDENCE_RECEIPT_CONTRACT_VERSION
  ) {
    reasons.push("receipt-contract-invalid");
  }
  if (
    receipt.diagnosticOnly !== true ||
    receipt.promotionEligible !== false ||
    receipt.resolutionNormalized !== false ||
    receipt.sealed !== true ||
    !Array.isArray(receipt.sealingErrors) ||
    receipt.sealingErrors.length !== 0
  ) {
    reasons.push("receipt-safety-state-invalid");
  }
  if (
    receipt.decoderContract !== SOURCE_GLYPH_EVIDENCE_DECODER_CONTRACT ||
    receipt.sourceEvidenceProfileContract !==
      "pattern-text-mask-zero-dilation-v1" ||
    receipt.residualProfileContract !== SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION
  ) {
    reasons.push("receipt-profile-invalid");
  }
  if (
    typeof receipt.pageId !== "string" ||
    !receipt.pageId ||
    !validSourceBaseline(source) ||
    !validBeforeBaseline(before, source) ||
    !validAfterBaseline(after)
  ) {
    reasons.push("receipt-baseline-invalid");
  }
  const blockIds = Object.keys(blocks).sort();
  if (blockIds.length === 0 || !validReceiptBlocks(blocks, blockIds, source)) {
    reasons.push("receipt-block-bindings-invalid");
  }
  if (receipt.blockIdsSha256 !== sha256Canonical(blockIds)) {
    reasons.push("receipt-block-id-sha-mismatch");
  }
  const { bindingSha256, ...receiptWithoutBinding } = receipt;
  if (
    !isSha256(bindingSha256) ||
    bindingSha256 !== sha256Canonical(receiptWithoutBinding)
  ) {
    reasons.push("receipt-binding-sha-mismatch");
  }
  return { valid: reasons.length === 0, reasons };
}

function validReceiptBlocks(
  blocks: Record<string, unknown>,
  blockIds: string[],
  source: Record<string, unknown>,
): boolean {
  return blockIds.every((blockId) => {
    const block = objectValue(blocks[blockId]);
    return (
      block.blockId === blockId &&
      validBounds(block.firstPassCoreBounds) &&
      isSha256(block.firstPassCoreSha256) &&
      validBounds(block.sourceEvidenceBounds) &&
      isSha256(block.sourceEvidenceSha256) &&
      ["adaptive", "otsu", "none"].includes(
        String(block.sourceEvidenceStrategy),
      ) &&
      block.sourceAssetSha256 === source.assetSha256 &&
      block.sourceBitmapSha256 === source.bitmapSha256
    );
  });
}

function validSourceBaseline(value: Record<string, unknown>): boolean {
  return (
    value.baselineKind === "immutable-original" && validAssetBaseline(value)
  );
}

function validBeforeBaseline(
  value: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  return (
    (value.baselineKind === "immutable-original" ||
      value.baselineKind === "retry-cleaned") &&
    validAssetBaseline(value) &&
    value.width === source.width &&
    value.height === source.height
  );
}

function validAfterBaseline(value: Record<string, unknown>): boolean {
  return (
    value.baselineKind === "cleaned-output-bitmap" &&
    typeof value.cleanedAssetPath === "string" &&
    value.cleanedAssetPath.length > 0 &&
    isSha256(value.bitmapSha256) &&
    isSha256(value.cleanedAssetSha256)
  );
}

function validAssetBaseline(value: Record<string, unknown>): boolean {
  return (
    typeof value.assetPath === "string" &&
    value.assetPath.length > 0 &&
    isSha256(value.assetSha256) &&
    isSha256(value.bitmapSha256) &&
    typeof value.width === "number" &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isInteger(value.height) &&
    value.height > 0
  );
}

function validBounds(value: unknown): boolean {
  const bounds = objectValue(value);
  return (
    typeof bounds.x === "number" &&
    Number.isInteger(bounds.x) &&
    bounds.x >= 0 &&
    typeof bounds.y === "number" &&
    Number.isInteger(bounds.y) &&
    bounds.y >= 0 &&
    typeof bounds.w === "number" &&
    Number.isInteger(bounds.w) &&
    bounds.w > 0 &&
    typeof bounds.h === "number" &&
    Number.isInteger(bounds.h) &&
    bounds.h > 0
  );
}

function assertPatternValidationBinding(
  mask: PatternMaskContext,
  index: number,
): void {
  const blockId = mask.validationBlockIds[index];
  const core = mask.validationWindowMasks[index];
  const evidence = mask.sourceGlyphEvidence[index];
  if (!blockId || !core || !evidence) {
    throw new Error("Source-glyph array evidence binding is invalid.");
  }
  const keyed = mask.validationBindingsByBlockId.get(blockId);
  if (!keyed || keyed.blockId !== blockId) {
    throw new Error("Source-glyph block-key evidence binding is invalid.");
  }
  if (hashWindowMask(keyed.firstPassCore) !== hashWindowMask(core)) {
    throw new Error("Source-glyph block-key core hash mismatch.");
  }
  if (keyed.sourceGlyphEvidence.strategy !== evidence.strategy) {
    throw new Error("Source-glyph block-key strategy mismatch.");
  }
  if (
    hashWindowMask(keyed.sourceGlyphEvidence.windowMask) !==
    hashWindowMask(evidence.windowMask)
  ) {
    throw new Error("Source-glyph block-key evidence hash mismatch.");
  }
}

export function hashSourceGlyphEvidence(evidence: SourceGlyphEvidence): string {
  return sha256Canonical({
    contract: "source-glyph-evidence-v1",
    strategy: evidence.strategy,
    windowMaskSha256: hashWindowMask(evidence.windowMask),
  });
}

// eslint-disable-next-line complexity -- every sealing prerequisite is reported rather than short-circuited.
function resolveSealingErrors(
  options: Parameters<typeof buildPatternSourceGlyphEvidenceReceipt>[0],
  blockCount: number,
): string[] {
  const errors: string[] = [];
  if (!options.pageId.trim()) errors.push("source-page-id-missing");
  if (!options.source.assetSha256) errors.push("source-asset-sha-missing");
  if (!options.before.assetSha256) errors.push("before-asset-sha-missing");
  if (options.source.bitmapSha256 !== sha256(options.source.bitmap)) {
    errors.push("source-bitmap-sha-mismatch");
  }
  if (options.before.bitmapSha256 !== sha256(options.before.bitmap)) {
    errors.push("before-bitmap-sha-mismatch");
  }
  if (options.source.width !== options.before.width) {
    errors.push("source-before-width-mismatch");
  }
  if (options.source.height !== options.before.height) {
    errors.push("source-before-height-mismatch");
  }
  if (options.afterBitmap.length !== options.source.bitmap.length) {
    errors.push("source-after-bitmap-length-mismatch");
  }
  if (blockCount <= 0) errors.push("block-bindings-missing");
  const expectedBlockIds = [...new Set(options.expectedBlockIds)].sort();
  const actualBlockIds = [...options.validationBindingsByBlockId.keys()].sort();
  if (JSON.stringify(expectedBlockIds) !== JSON.stringify(actualBlockIds)) {
    errors.push("eligible-block-membership-mismatch");
  }
  if (!options.cleanedAssetPath || !options.cleanedAssetBytes) {
    errors.push("cleaned-asset-sha-missing");
  }
  return errors;
}

function withoutBitmap(baseline: PatternBitmapBaseline) {
  const { bitmap: _bitmap, ...receipt } = baseline;
  return receipt;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
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
