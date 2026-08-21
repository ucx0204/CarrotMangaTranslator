const nodeCrypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const QA_PAGE_COMPLETION_CONTRACT_VERSION =
  "library-full-pipeline-qa-page-completion-v1";
const QA_EXPECTED_COMPLETION_WORKFLOW = "bubble-layout";

/** @param {any} page @param {string} [expectedWorkflow] @returns {any} */
function seedQaTranslationCompletion(
  page,
  expectedWorkflow = QA_EXPECTED_COMPLETION_WORKFLOW,
) {
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    throw new Error("QA translation page is invalid.");
  }
  if (
    page.translationCompletion &&
    page.translationCompletion.workflow !== expectedWorkflow
  ) {
    throw new Error("QA translation completion workflow mismatch.");
  }
  return {
    ...page,
    translationCompletion: { workflow: expectedWorkflow, status: "pending" },
  };
}

/**
 * Execution success and production translation completion are independent.
 * A page may have executed every QA stage while remaining pending or failed.
 * @param {any} options
 * @returns {Promise<any>}
 */
async function resolveQaPageCompletion(options) {
  const executionStatus = normalizeExecutionStatus(options.executionStatus);
  const translationCompletion = normalizeTranslationCompletion(
    options.translationCompletion,
  );
  const expectedWorkflow =
    options.expectedWorkflow || QA_EXPECTED_COMPLETION_WORKFLOW;
  const blocksIncomplete = normalizeCount(options.blocksIncomplete);
  const cleanedAsset = await inspectCleanedAsset(options.cleanedImagePath);
  const sourceEvidenceBindingRequired =
    options.sourceEvidenceBindingRequired === true;
  const sourceAsset = sourceEvidenceBindingRequired
    ? await inspectCleanedAsset(options.expectedSourceImagePath)
    : null;
  const sourceEvidenceBinding = inspectSourceEvidenceBinding({
    cleanedAsset,
    cleanedAssetKind: options.cleanedAssetKind,
    expectedSourceImagePath: options.expectedSourceImagePath,
    expectedSourcePageId: options.expectedSourcePageId,
    expectedSourceSha256: options.expectedSourceSha256,
    receipt: options.sourceEvidenceReceipt,
    required: sourceEvidenceBindingRequired,
    sourceAsset: sourceAsset ?? { available: false, path: null, sha256: null },
  });
  const failureReasons = [];
  if (executionStatus !== "completed") {
    failureReasons.push("execution-not-completed");
  }
  if (!cleanedAsset.available) {
    failureReasons.push("cleaned-asset-missing");
  }
  if (!sourceEvidenceBinding.valid) {
    failureReasons.push("source-evidence-receipt-invalid");
  }
  if (!translationCompletion) {
    failureReasons.push("translation-completion-missing");
  } else if (translationCompletion.workflow !== expectedWorkflow) {
    failureReasons.push("translation-completion-workflow-mismatch");
  } else if (translationCompletion.status === "failed") {
    failureReasons.push("translation-completion-failed");
  } else if (translationCompletion.status !== "completed") {
    failureReasons.push("translation-completion-pending");
  }
  if (blocksIncomplete > 0) {
    failureReasons.push("blocks-incomplete");
  }
  const status = resolvePageStatus({
    blocksIncomplete,
    cleanedAsset,
    ...(sourceAsset ? { sourceAsset } : {}),
    executionStatus,
    expectedWorkflow,
    sourceEvidenceBinding,
    translationCompletion,
  });
  return {
    completionContractVersion: QA_PAGE_COMPLETION_CONTRACT_VERSION,
    status,
    stage:
      status === "completed"
        ? "done"
        : status === "pending"
          ? "translation-completion-pending"
          : "completion-contract-failed",
    executionStatus,
    productionTranslationCompletion: translationCompletion,
    expectedTranslationCompletionWorkflow: expectedWorkflow,
    cleanedAsset,
    sourceEvidenceBinding,
    completionFailureReasons: failureReasons,
  };
}

/** @param {any} options @returns {"completed" | "failed" | "pending"} */
function resolvePageStatus(options) {
  if (
    options.executionStatus !== "completed" ||
    !options.cleanedAsset.available ||
    !options.sourceEvidenceBinding.valid ||
    !options.translationCompletion ||
    options.translationCompletion.workflow !== options.expectedWorkflow ||
    options.translationCompletion.status === "failed"
  ) {
    return "failed";
  }
  if (
    options.translationCompletion.status === "pending" ||
    options.blocksIncomplete > 0
  ) {
    return "pending";
  }
  return options.translationCompletion.status === "completed"
    ? "completed"
    : "failed";
}

/** @param {any} options @returns {any} */
// eslint-disable-next-line complexity -- this fail-closed receipt gate intentionally enumerates every independent binding.
function inspectSourceEvidenceBinding(options) {
  if (!options.required) {
    return { required: false, valid: true, kind: "not-required", reasons: [] };
  }
  const reasons = [];
  if (!isSha256(options.expectedSourceSha256)) {
    reasons.push("expected-source-sha-invalid");
  }
  if (
    !options.sourceAsset.available ||
    options.sourceAsset.sha256 !== options.expectedSourceSha256
  ) {
    reasons.push("source-asset-sha-mismatch");
  }
  if (String(options.cleanedAssetKind || "").startsWith("targetless-")) {
    if (options.cleanedAsset.sha256 !== options.expectedSourceSha256) {
      reasons.push("targetless-copy-source-sha-mismatch");
    }
    return {
      required: true,
      valid: reasons.length === 0,
      kind: options.cleanedAssetKind,
      reasons,
      receiptBindingSha256: null,
    };
  }
  const receipt = options.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    reasons.push("source-evidence-receipt-missing");
  } else {
    reasons.push(...verifySourceEvidenceReceipt(receipt));
    if (receipt.sealed !== true)
      reasons.push("source-evidence-receipt-unsealed");
    if (receipt.pageId !== options.expectedSourcePageId) {
      reasons.push("source-evidence-page-id-mismatch");
    }
    if (receipt.source?.assetSha256 !== options.expectedSourceSha256) {
      reasons.push("source-evidence-source-sha-mismatch");
    }
    if (
      resolveOptionalPath(receipt.source?.assetPath) !==
      resolveOptionalPath(options.expectedSourceImagePath)
    ) {
      reasons.push("source-evidence-source-path-mismatch");
    }
    if (receipt.after?.cleanedAssetSha256 !== options.cleanedAsset.sha256) {
      reasons.push("source-evidence-cleaned-sha-mismatch");
    }
    if (
      resolveOptionalPath(receipt.after?.cleanedAssetPath) !==
      options.cleanedAsset.path
    ) {
      reasons.push("source-evidence-cleaned-path-mismatch");
    }
    if (receipt.decoderContract !== "electron-native-image-bgra8-v1") {
      reasons.push("source-evidence-decoder-contract-mismatch");
    }
    if (
      receipt.sourceEvidenceProfileContract !==
        "pattern-text-mask-zero-dilation-v1" ||
      receipt.residualProfileContract !== "source-glyph-residual-v1"
    ) {
      reasons.push("source-evidence-profile-contract-mismatch");
    }
  }
  return {
    required: true,
    valid: reasons.length === 0,
    kind: options.cleanedAssetKind || "production-inpainted",
    reasons,
    receiptBindingSha256: receipt?.bindingSha256 ?? null,
  };
}

/** @param {any} receipt @returns {string[]} */
function verifySourceEvidenceReceipt(receipt) {
  const reasons = [];
  if (
    receipt.contractVersion !== "source-glyph-evidence-receipt-v1" ||
    receipt.diagnosticOnly !== true ||
    receipt.promotionEligible !== false ||
    receipt.resolutionNormalized !== false ||
    !Array.isArray(receipt.sealingErrors) ||
    receipt.sealingErrors.length !== 0
  ) {
    reasons.push("source-evidence-receipt-contract-invalid");
  }
  if (
    typeof receipt.pageId !== "string" ||
    !receipt.pageId ||
    !validSourceBaseline(receipt.source) ||
    !validBeforeBaseline(receipt.before, receipt.source) ||
    !validAfterBaseline(receipt.after)
  ) {
    reasons.push("source-evidence-receipt-baseline-invalid");
  }
  const blocks = objectValue(receipt.blocksById);
  const blockIds = Object.keys(blocks).sort();
  if (
    blockIds.length === 0 ||
    blockIds.some((blockId) => {
      const block = objectValue(blocks[blockId]);
      return (
        block.blockId !== blockId ||
        !validBounds(block.firstPassCoreBounds) ||
        !isSha256(block.firstPassCoreSha256) ||
        !validBounds(block.sourceEvidenceBounds) ||
        !isSha256(block.sourceEvidenceSha256) ||
        !["adaptive", "otsu", "none"].includes(
          String(block.sourceEvidenceStrategy),
        ) ||
        block.sourceAssetSha256 !== receipt.source?.assetSha256 ||
        block.sourceBitmapSha256 !== receipt.source?.bitmapSha256
      );
    })
  ) {
    reasons.push("source-evidence-receipt-blocks-invalid");
  }
  if (receipt.blockIdsSha256 !== sha256Canonical(blockIds)) {
    reasons.push("source-evidence-receipt-block-id-sha-invalid");
  }
  const { bindingSha256, ...receiptWithoutBinding } = receipt;
  if (
    !isSha256(bindingSha256) ||
    bindingSha256 !== sha256Canonical(receiptWithoutBinding)
  ) {
    reasons.push("source-evidence-receipt-binding-invalid");
  }
  return reasons;
}

/** @param {any} value @returns {boolean} */
function validSourceBaseline(value) {
  const source = objectValue(value);
  return source.baselineKind === "immutable-original" && validBaseline(source);
}

/** @param {any} value @param {any} sourceValue @returns {boolean} */
function validBeforeBaseline(value, sourceValue) {
  const before = objectValue(value);
  const source = objectValue(sourceValue);
  return (
    (before.baselineKind === "immutable-original" ||
      before.baselineKind === "retry-cleaned") &&
    validBaseline(before) &&
    before.width === source.width &&
    before.height === source.height
  );
}

/** @param {any} value @returns {boolean} */
function validAfterBaseline(value) {
  const after = objectValue(value);
  return (
    after.baselineKind === "cleaned-output-bitmap" &&
    typeof after.cleanedAssetPath === "string" &&
    after.cleanedAssetPath.length > 0 &&
    isSha256(after.bitmapSha256) &&
    isSha256(after.cleanedAssetSha256)
  );
}

/** @param {any} value @returns {boolean} */
function validBaseline(value) {
  return (
    typeof value.assetPath === "string" &&
    value.assetPath.length > 0 &&
    isSha256(value.assetSha256) &&
    isSha256(value.bitmapSha256) &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    Number.isInteger(value.height) &&
    value.height > 0
  );
}

/** @param {any} value @returns {boolean} */
function validBounds(value) {
  const bounds = objectValue(value);
  return (
    Number.isInteger(bounds.x) &&
    bounds.x >= 0 &&
    Number.isInteger(bounds.y) &&
    bounds.y >= 0 &&
    Number.isInteger(bounds.w) &&
    bounds.w > 0 &&
    Number.isInteger(bounds.h) &&
    bounds.h > 0
  );
}

/** @param {any} result @param {{ targetless?: boolean }} [options] @returns {any} */
function assertQaInpaintingResultMatchesProduction(result, options = {}) {
  if (
    !result ||
    typeof result !== "object" ||
    (result.blocksErased <= 0 && options.targetless !== true)
  ) {
    throw new Error(
      "Production inpainting completion rejects a page with no erased blocks.",
    );
  }
  return result;
}

/** @param {any} page @returns {boolean} */
function isQaTargetlessPage(page) {
  return (
    Array.isArray(page?.blocks) &&
    (page.blocks.length === 0 ||
      page.blocks.every(
        /** @param {any} block */ (block) => block?.inpaintExcluded === true,
      ))
  );
}

/** @param {any[]} reportPages @param {string[]} expectedPageIds @returns {boolean} */
function isQaRunExactlyCompleted(reportPages, expectedPageIds) {
  if (
    !Array.isArray(reportPages) ||
    !Array.isArray(expectedPageIds) ||
    reportPages.length !== expectedPageIds.length
  ) {
    return false;
  }
  const expected = new Set(expectedPageIds.map(String));
  if (expected.size !== expectedPageIds.length) return false;
  const actual = new Set();
  for (const page of reportPages) {
    const pageId = String(page?.sourcePageId ?? "");
    if (!pageId || actual.has(pageId) || !expected.has(pageId)) return false;
    actual.add(pageId);
    if (page.status !== "completed") return false;
  }
  return actual.size === expected.size;
}

/** @param {any} filePath @returns {Promise<any>} */
async function inspectCleanedAsset(filePath) {
  const resolvedPath =
    typeof filePath === "string" && filePath.trim()
      ? path.resolve(filePath)
      : null;
  if (!resolvedPath) {
    return {
      available: false,
      path: null,
      sizeBytes: null,
      sha256: null,
    };
  }
  try {
    const bytes = await fs.readFile(resolvedPath);
    return {
      available: bytes.length > 0,
      path: resolvedPath,
      sizeBytes: bytes.length,
      sha256: nodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return {
        available: false,
        path: resolvedPath,
        sizeBytes: null,
        sha256: null,
      };
    }
    throw error;
  }
}

/** @param {any} value @returns {any | null} */
function normalizeTranslationCompletion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value.status;
  if (status !== "pending" && status !== "completed" && status !== "failed") {
    return null;
  }
  return structuredClone(value);
}

/** @param {any} value @returns {"completed" | "failed" | "pending"} */
function normalizeExecutionStatus(value) {
  return value === "completed" || value === "failed" || value === "pending"
    ? value
    : "failed";
}

/** @param {any} value @returns {number} */
function normalizeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/** @param {any} value @returns {string | null} */
function resolveOptionalPath(value) {
  return typeof value === "string" && value.trim() ? path.resolve(value) : null;
}

/** @param {any} value @returns {boolean} */
function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** @param {any} value @returns {Record<string, any>} */
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/** @param {any} value @returns {string} */
function sha256Canonical(value) {
  return nodeCrypto
    .createHash("sha256")
    .update(Buffer.from(stableStringify(value)))
    .digest("hex");
}

/** @param {any} value @returns {string} */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

module.exports = {
  QA_EXPECTED_COMPLETION_WORKFLOW,
  QA_PAGE_COMPLETION_CONTRACT_VERSION,
  assertQaInpaintingResultMatchesProduction,
  isQaRunExactlyCompleted,
  isQaTargetlessPage,
  resolveQaPageCompletion,
  seedQaTranslationCompletion,
};
