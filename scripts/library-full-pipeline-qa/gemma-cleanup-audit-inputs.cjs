/* eslint-disable max-lines -- immutable image, manifest, and path validation remain one fail-closed frozen-input boundary */
// @ts-check

const fsp = require("node:fs/promises");
const path = require("node:path");
const { isQaRunExactlyCompleted } = require("./page-completion-contract.cjs");
const {
  AUDIT_CONTRACT_VERSION,
  INTEGRITY_SCOPE,
  KNOWN_BLOCK_PROMPT_CONTRACT_VERSION,
  MAX_EVIDENCE_ALIASES,
  OFFICIAL_EMPTY_THOUGHT_PREFIX,
  OFFICIAL_EMPTY_THOUGHT_PREFIX_KIND,
  PROMPT_CONTRACT_VERSION,
  RESPONSE_FORMAT_DIALECT,
  RESPONSE_SCHEMA_VERSION,
  UNASSIGNED_PROMPT_CONTRACT_VERSION,
  sha256,
  sha256Canonical,
} = require("./gemma-cleanup-audit-contract.cjs");

const FROZEN_MANIFEST_PATH = path.join(
  __dirname,
  "gemma-cleanup-audit-baseline20.json",
);
// This digest lives outside the manifest so a locally edited and reserialized
// manifest cannot redefine its own authority.
const FROZEN_MANIFEST_SHA256 =
  "a88811b86bf0a271fa30c4ecd90e1e373dfb5da11d276b3a3c58e378ba2fe990";

/** @typedef {import("./gemma-cleanup-audit-contract.cjs")} ContractModule */
/** @typedef {{selectionIndex:number;expectedClass:"clean"|"residual";pageId:string;workId:string;chapterId:string;originalRelativePath:string;originalSha256:string;cleanedRelativePath:string;cleanedSha256:string;fontInputRelativePath:string;fontInputSha256:string;blockCount:number;orderedBlockIdsSha256:string;v4ContractPins:Record<string,unknown>}} FrozenPage */
/** @typedef {{schemaVersion:number;contractVersion:string;shadowOnly:boolean;promotionEligible:boolean;productionMutationAllowed:boolean;evaluationRole:string;holdoutEligible:boolean;consumedDevelopmentEvidence:string[];integrityScope:Record<string,unknown>;exactImageOrder:string[];outputContract:Record<string,unknown>;promptGeometryContract:Record<string,unknown>;source:{runRoot:string;runReport:string;runReportSha256:string;runConfig:string;runConfigSha256:string;manualLedger:string;manualLedgerSha256:string;legacyRunStatusMeaning:string};model:Record<string,any>;positiveSelectionIndices:number[];negativeSelectionIndices:number[];pages:FrozenPage[]}} FrozenManifest */

/**
 * @param {string} root
 * @param {string} [manifestPath]
 * @returns {Promise<{manifest:FrozenManifest;manifestPath:string;manifestSha256:string}>}
 */
async function loadFrozenManifest(root, manifestPath = FROZEN_MANIFEST_PATH) {
  const resolvedManifestPath = path.resolve(root, manifestPath);
  const bytes = await fsp.readFile(resolvedManifestPath);
  const manifestSha256 = sha256(bytes);
  if (
    resolvedManifestPath === path.resolve(FROZEN_MANIFEST_PATH) &&
    manifestSha256 !== FROZEN_MANIFEST_SHA256
  ) {
    throw new Error("Cleanup audit frozen manifest hash mismatch.");
  }
  const manifest = /** @type {FrozenManifest} */ (
    JSON.parse(bytes.toString("utf8"))
  );
  validateFrozenManifest(manifest);
  return {
    manifest,
    manifestPath: resolvedManifestPath,
    manifestSha256,
  };
}

/**
 * Validate all immutable global inputs once, then materialize only requested
 * pages. Existing source/run files are never written.
 * @param {{root:string;indices:number[];manifestPath?:string}} options
 */
async function loadFrozenAuditInputs(options) {
  const loaded = await loadFrozenManifest(options.root, options.manifestPath);
  const root = path.resolve(options.root);
  const runRoot = resolveContained(root, loaded.manifest.source.runRoot);
  const runReportPath = resolveContained(
    runRoot,
    loaded.manifest.source.runReport,
  );
  const runConfigPath = resolveContained(
    runRoot,
    loaded.manifest.source.runConfig,
  );
  const ledgerPath = resolveContained(
    root,
    loaded.manifest.source.manualLedger,
  );
  await assertFileSha(runReportPath, loaded.manifest.source.runReportSha256);
  await assertFileSha(runConfigPath, loaded.manifest.source.runConfigSha256);
  await assertFileSha(ledgerPath, loaded.manifest.source.manualLedgerSha256);
  const runReport = await readJson(runReportPath);
  const selectedManifestPages = selectManifestPages(
    loaded.manifest,
    options.indices,
  );
  const allReportPages = arrayValue(runReport.pages);
  const selectedReportPages = selectedManifestPages.map((page) =>
    findReportPage(allReportPages, page.selectionIndex),
  );
  if (
    !isQaRunExactlyCompleted(
      selectedReportPages,
      selectedManifestPages.map((page) => page.pageId),
    )
  ) {
    throw new Error(
      "Frozen cleanup audit pages do not match the existing QA completion inventory.",
    );
  }
  const pages = [];
  for (const [index, frozenPage] of selectedManifestPages.entries()) {
    pages.push(
      await loadFrozenPage({
        frozenPage,
        reportPage: selectedReportPages[index],
        runRoot,
      }),
    );
  }
  return {
    ...loaded,
    root,
    runRoot,
    runReportPath,
    runReportSha256: loaded.manifest.source.runReportSha256,
    runConfigPath,
    runConfigSha256: loaded.manifest.source.runConfigSha256,
    ledgerPath,
    ledgerSha256: loaded.manifest.source.manualLedgerSha256,
    pages,
  };
}

/**
 * @param {{frozenPage:FrozenPage;reportPage:Record<string,unknown>;runRoot:string}} options
 */
async function loadFrozenPage(options) {
  const { frozenPage, reportPage, runRoot } = options;
  assertReportBinding(frozenPage, reportPage, runRoot);
  const originalPath = resolveContained(
    runRoot,
    frozenPage.originalRelativePath,
  );
  const cleanedPath = resolveContained(runRoot, frozenPage.cleanedRelativePath);
  const fontInputPath = resolveContained(
    runRoot,
    frozenPage.fontInputRelativePath,
  );
  const [original, cleaned, fontInputBytes] = await Promise.all([
    loadExactImage(originalPath, frozenPage.originalSha256, "original"),
    loadExactImage(cleanedPath, frozenPage.cleanedSha256, "cleaned"),
    fsp.readFile(fontInputPath),
  ]);
  if (sha256(fontInputBytes) !== frozenPage.fontInputSha256) {
    throw new Error(
      `Frozen cleanup audit font input hash mismatch: ${fontInputPath}`,
    );
  }
  const fontInput = /** @type {Record<string,unknown>} */ (
    JSON.parse(fontInputBytes.toString("utf8"))
  );
  const blocks = readImmutableBlocks(fontInput, frozenPage);
  if (original.width !== cleaned.width || original.height !== cleaned.height) {
    throw new Error(
      "Frozen cleanup audit images do not share exact full-page dimensions.",
    );
  }
  return {
    selectionIndex: frozenPage.selectionIndex,
    expectedClass: frozenPage.expectedClass,
    pageId: frozenPage.pageId,
    workId: frozenPage.workId,
    chapterId: frozenPage.chapterId,
    originalPath,
    cleanedPath,
    fontInputPath,
    original,
    cleaned,
    fontInputSha256: frozenPage.fontInputSha256,
    blocks,
    orderedBlockIdsSha256: frozenPage.orderedBlockIdsSha256,
    v4ContractPins: structuredClone(frozenPage.v4ContractPins),
    sourceRunStatus: "completed",
    sourceRunStatusSemantics: "legacy-execution-only",
  };
}

/**
 * @param {string} imagePath
 * @param {string} expectedSha256
 * @param {"original"|"cleaned"} role
 */
async function loadExactImage(imagePath, expectedSha256, role) {
  const bytes = await fsp.readFile(imagePath);
  if (bytes.length === 0) throw new Error(`Frozen ${role} image is empty.`);
  const digest = sha256(bytes);
  if (digest !== expectedSha256) {
    throw new Error(`Frozen ${role} image hash mismatch: ${imagePath}`);
  }
  const mime = detectExactImageMime(bytes);
  const dimensions = readExactImageDimensions(bytes, mime);
  return {
    role,
    mime,
    sourceBytes: bytes.length,
    sourceSha256: digest,
    payloadBytes: bytes.length,
    payloadSha256: digest,
    ...dimensions,
    dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
  };
}

/** @param {Buffer} bytes @param {"image/png"|"image/jpeg"} mime */
// eslint-disable-next-line complexity -- strict PNG/JPEG marker parsing validates both formats without a decoder rewrite
function readExactImageDimensions(bytes, mime) {
  if (mime === "image/png") {
    if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("Cleanup audit PNG dimension header is invalid.");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1) {
      throw new Error("Cleanup audit PNG dimensions are invalid.");
    }
    return { width, height };
  }
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) break;
      return { width, height };
    }
    offset += length;
  }
  throw new Error("Cleanup audit JPEG dimensions are unavailable.");
}

/** @param {Buffer} bytes @returns {"image/png"|"image/jpeg"} */
function detectExactImageMime(bytes) {
  const isPng =
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (isPng) return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  throw new Error(
    "Cleanup audit accepts exact PNG/JPEG payloads only; conversion is forbidden.",
  );
}

/** @param {Record<string,unknown>} fontInput @param {FrozenPage} page */
function readImmutableBlocks(fontInput, page) {
  if (
    fontInput.sourcePageId !== page.pageId ||
    fontInput.sourcePageSha256 !== page.originalSha256
  ) {
    throw new Error("Frozen font input source binding mismatch.");
  }
  const requestBlocks = arrayValue(fontInput.requestBlocks);
  const sourcePageBlocks = arrayValue(objectValue(fontInput.page).blocks);
  if (
    requestBlocks.length !== page.blockCount ||
    sourcePageBlocks.length !== page.blockCount
  ) {
    throw new Error("Frozen font input block count mismatch.");
  }
  const sourceBlockIds = sourcePageBlocks.map((entry) =>
    stringValue(objectValue(entry).id),
  );
  if (
    sourceBlockIds.some((blockId) => !blockId) ||
    new Set(sourceBlockIds).size !== sourceBlockIds.length
  ) {
    throw new Error("Frozen font input source block inventory is invalid.");
  }
  const blocks = requestBlocks.map((entry, order) => {
    const record = objectValue(entry);
    const item = objectValue(record.item);
    const blockId = stringValue(record.blockId);
    if (!blockId) throw new Error("Frozen font input has an empty block ID.");
    const sourceMatches = sourcePageBlocks
      .map(objectValue)
      .filter((candidate) => stringValue(candidate.id) === blockId);
    if (sourceMatches.length !== 1) {
      throw new Error("Frozen font input block bbox membership mismatch.");
    }
    const sourceBlock = sourceMatches[0];
    if (sourceBlock.bboxSpace !== "normalized_1000") {
      throw new Error(
        "Frozen cleanup audit supports normalized_1000 bboxSpace only.",
      );
    }
    if (sha256Canonical(sourceBlock.bbox) !== sha256Canonical(item.bbox)) {
      throw new Error("Frozen font input block bbox binding mismatch.");
    }
    return {
      blockId,
      order,
      sourceText: stringValue(item.sourceText || item.jp),
      translatedText: stringValue(item.translatedText || item.ko),
      bbox1000: readNormalized1000Bbox(item.bbox),
      bboxSpace: /** @type {const} */ ("normalized_1000"),
      textRole: stringValue(item.textRole) || "ordinary",
    };
  });
  const blockIds = blocks.map((block) => block.blockId);
  if (new Set(blockIds).size !== blockIds.length) {
    throw new Error("Frozen font input has duplicate block IDs.");
  }
  if (sha256Canonical(blockIds) !== page.orderedBlockIdsSha256) {
    throw new Error("Frozen font input block ID order digest mismatch.");
  }
  return blocks;
}

/** @param {unknown} value */
function readNormalized1000Bbox(value) {
  const bbox = objectValue(value);
  const keys = Object.keys(bbox).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["h", "w", "x", "y"])) {
    throw new Error("Frozen cleanup audit bbox1000 keys are invalid.");
  }
  const result = {
    x: Number(bbox.x),
    y: Number(bbox.y),
    w: Number(bbox.w),
    h: Number(bbox.h),
  };
  if (
    Object.values(result).some((coordinate) => !Number.isFinite(coordinate)) ||
    result.x < 0 ||
    result.y < 0 ||
    result.w < 0 ||
    result.h < 0 ||
    result.x > 1_000 ||
    result.y > 1_000 ||
    result.x + result.w > 1_000.000_001 ||
    result.y + result.h > 1_000.000_001
  ) {
    throw new Error("Frozen cleanup audit bbox1000 is outside the page.");
  }
  return result;
}

/** @param {FrozenManifest} manifest */
// eslint-disable-next-line complexity -- the externally hashed frozen manifest is validated as one atomic contract
function validateFrozenManifest(manifest) {
  if (
    manifest.schemaVersion !== 4 ||
    manifest.contractVersion !== "gemma-cleanup-audit-frozen-baseline20-v4" ||
    manifest.shadowOnly !== true ||
    manifest.promotionEligible !== false ||
    manifest.productionMutationAllowed !== false
  ) {
    throw new Error(
      "Cleanup audit frozen manifest safety contract is invalid.",
    );
  }
  if (
    manifest.evaluationRole !== "development-only-not-holdout" ||
    manifest.holdoutEligible !== false ||
    !Array.isArray(manifest.consumedDevelopmentEvidence) ||
    manifest.consumedDevelopmentEvidence.length < 1
  ) {
    throw new Error(
      "Cleanup audit frozen development-evidence contract changed.",
    );
  }
  if (
    JSON.stringify(manifest.exactImageOrder) !==
    JSON.stringify(["Image1:original", "Image2:cleaned"])
  ) {
    throw new Error("Cleanup audit frozen image role/order contract changed.");
  }
  const outputContract = manifest.outputContract;
  if (
    outputContract?.promptContractVersion !== PROMPT_CONTRACT_VERSION ||
    outputContract?.knownBlockPromptContractVersion !==
      KNOWN_BLOCK_PROMPT_CONTRACT_VERSION ||
    outputContract?.unassignedPromptContractVersion !==
      UNASSIGNED_PROMPT_CONTRACT_VERSION ||
    outputContract?.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION ||
    outputContract?.responseFormatDialect !== RESPONSE_FORMAT_DIALECT ||
    outputContract?.maximumEvidenceAliases !== MAX_EVIDENCE_ALIASES ||
    JSON.stringify(outputContract?.passOrder) !==
      JSON.stringify(["known-block", "unassigned-source"]) ||
    outputContract?.unassignedExecutionGate !== "known-block-clean-only" ||
    outputContract?.unassignedEvidenceUse !==
      "human-review-only-never-production-mutation" ||
    outputContract?.invalidOrEmptyUnassignedEvidence !== "uncertain" ||
    outputContract?.modelFacingIdentifiers !== "aliases-only" ||
    outputContract?.artifactResultIdentifiers !== "immutable-block-ids" ||
    outputContract?.officialEmptyThoughtPrefixKind !==
      OFFICIAL_EMPTY_THOUGHT_PREFIX_KIND ||
    outputContract?.officialEmptyThoughtPrefixSha256 !==
      sha256(Buffer.from(OFFICIAL_EMPTY_THOUGHT_PREFIX)) ||
    outputContract?.officialEmptyThoughtPrefixBytes !==
      Buffer.byteLength(OFFICIAL_EMPTY_THOUGHT_PREFIX) ||
    outputContract?.arbitraryProseOrControlPrefixAccepted !== false
  ) {
    throw new Error("Cleanup audit frozen output contract changed.");
  }
  if (
    sha256Canonical(manifest.promptGeometryContract) !==
    sha256Canonical({
      field: "bbox1000",
      bboxSpace: "normalized_1000",
      coordinateRange: [0, 1000],
      origin: "top-left",
      xDirection: "right",
      yDirection: "down",
      unsupportedBboxSpaceRejected: true,
    })
  ) {
    throw new Error("Cleanup audit frozen prompt geometry contract changed.");
  }
  if (
    sha256Canonical(manifest.integrityScope) !==
    sha256Canonical(INTEGRITY_SCOPE)
  ) {
    throw new Error("Cleanup audit frozen integrity scope changed.");
  }
  const model = /** @type {Record<string,any>} */ (manifest.model);
  if (
    model.provider !== "gemma" ||
    model.source !== "huggingface" ||
    model.revision !== "9cada68ea11a8f361e4b16a7a97e53d99b0918c0" ||
    model.expectedSha256 !==
      "b7c13509c19383cf8fa4c8b1731ff5bd3a6e2f0e0ca5a63958afee1ee64f387d" ||
    model.mmproj?.revision !== "8842483d589b4add67223d1d8c3fff81a3d5260e" ||
    model.mmproj?.expectedSha256 !==
      "b9dd7e71eb78b44c4c9d3a0aa6173a1e022c2c4f58aa0fd03807be3f8cba4353" ||
    model.chatTemplate?.revision !==
      "4d7ae4984b7db7de8f8457170b3f1a419ee76d52" ||
    model.chatTemplate?.expectedSha256 !==
      "ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4" ||
    model.chatTemplate?.expectedBytes !== 18_683 ||
    model.serverRuntime?.exactLaunchedPathShaAndBytesRequiredPerRun !== true
  ) {
    throw new Error("Cleanup audit frozen runtime pin contract changed.");
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length !== 10) {
    throw new Error("Cleanup audit frozen manifest must contain ten pages.");
  }
  if (
    JSON.stringify(manifest.positiveSelectionIndices) !==
      JSON.stringify([1, 6, 8, 10, 14, 18]) ||
    JSON.stringify(manifest.negativeSelectionIndices) !==
      JSON.stringify([3, 4, 5, 13])
  ) {
    throw new Error("Cleanup audit frozen positive/negative cohort changed.");
  }
  const expectedIndices = [
    ...manifest.positiveSelectionIndices,
    ...manifest.negativeSelectionIndices,
  ].sort((left, right) => left - right);
  const actualIndices = manifest.pages
    .map((page) => page.selectionIndex)
    .sort((left, right) => left - right);
  if (JSON.stringify(actualIndices) !== JSON.stringify(expectedIndices)) {
    throw new Error("Cleanup audit frozen page inventory is inconsistent.");
  }
  if (
    new Set(manifest.pages.map((page) => page.pageId)).size !== 10 ||
    new Set(manifest.pages.map((page) => page.workId)).size !== 10 ||
    new Set(manifest.pages.map((page) => page.chapterId)).size !== 10
  ) {
    throw new Error(
      "Cleanup audit frozen pages must be page/work/chapter-disjoint.",
    );
  }
  for (const page of manifest.pages) validateFrozenPage(page, manifest);
}

/** @param {FrozenPage} page @param {FrozenManifest} manifest */
// eslint-disable-next-line complexity -- every externally hashed per-page v2 pin is checked together
function validateFrozenPage(page, manifest) {
  const expectedClass = manifest.positiveSelectionIndices.includes(
    page.selectionIndex,
  )
    ? "residual"
    : "clean";
  if (page.expectedClass !== expectedClass) {
    throw new Error("Cleanup audit frozen label/index mismatch.");
  }
  const hashes = [
    page.originalSha256,
    page.cleanedSha256,
    page.fontInputSha256,
    page.orderedBlockIdsSha256,
    page.v4ContractPins?.aliasMapSha256,
    page.v4ContractPins?.aliasToBlockIdSha256,
    page.v4ContractPins?.blockIdToAliasSha256,
    page.v4ContractPins?.bbox1000Sha256,
    page.v4ContractPins?.knownBlockPromptSha256,
    page.v4ContractPins?.knownBlockResponseFormatSha256,
    page.v4ContractPins?.knownBlockInitialRequestBodySha256,
    page.v4ContractPins?.unassignedPromptSha256,
    page.v4ContractPins?.unassignedResponseFormatSha256,
    page.v4ContractPins?.unassignedInitialRequestBodySha256,
    page.v4ContractPins?.officialEmptyThoughtPrefixSha256,
  ];
  if (
    hashes.some(
      (digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest),
    )
  ) {
    throw new Error("Cleanup audit frozen page has an invalid hash.");
  }
  if (!Number.isInteger(page.blockCount) || page.blockCount < 1) {
    throw new Error("Cleanup audit frozen page block count is invalid.");
  }
  if (
    page.v4ContractPins?.contractVersion !== AUDIT_CONTRACT_VERSION ||
    page.v4ContractPins?.promptContractVersion !== PROMPT_CONTRACT_VERSION ||
    page.v4ContractPins?.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION ||
    page.v4ContractPins?.responseFormatDialect !== RESPONSE_FORMAT_DIALECT ||
    page.v4ContractPins?.bbox1000ContractVersion !==
      "full-page-normalized-1000-top-left-v1" ||
    JSON.stringify(page.v4ContractPins?.passOrder) !==
      JSON.stringify(["known-block", "unassigned-source"]) ||
    page.v4ContractPins?.unassignedExecutionGate !== "known-block-clean-only" ||
    page.v4ContractPins?.unassignedEvidenceUse !==
      "human-review-only-never-production-mutation" ||
    page.v4ContractPins?.officialEmptyThoughtPrefixKind !==
      OFFICIAL_EMPTY_THOUGHT_PREFIX_KIND ||
    page.v4ContractPins?.officialEmptyThoughtPrefixSha256 !==
      sha256(Buffer.from(OFFICIAL_EMPTY_THOUGHT_PREFIX)) ||
    page.v4ContractPins?.officialEmptyThoughtPrefixBytes !==
      Buffer.byteLength(OFFICIAL_EMPTY_THOUGHT_PREFIX)
  ) {
    throw new Error("Cleanup audit frozen page v4 contract pins are invalid.");
  }
}

/** @param {FrozenManifest} manifest @param {number[]} indices */
function selectManifestPages(manifest, indices) {
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error("At least one frozen cleanup audit index is required.");
  }
  if (
    indices.some((index) => !Number.isInteger(index)) ||
    new Set(indices).size !== indices.length
  ) {
    throw new Error("Cleanup audit indices must be unique integers.");
  }
  return indices.map((index) => {
    const page = manifest.pages.find(
      (candidate) => candidate.selectionIndex === index,
    );
    if (!page) throw new Error(`Selection index ${index} is not frozen.`);
    return page;
  });
}

/** @param {unknown[]} pages @param {number} selectionIndex */
function findReportPage(pages, selectionIndex) {
  const matches = pages.filter(
    (page) => objectValue(page).selectionIndex === selectionIndex,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Frozen run page ${selectionIndex} is missing or duplicated.`,
    );
  }
  return objectValue(matches[0]);
}

/** @param {FrozenPage} frozen @param {Record<string,unknown>} report @param {string} runRoot */
function assertReportBinding(frozen, report, runRoot) {
  const scalarBindings = [
    [report.sourcePageId, frozen.pageId],
    [report.sourcePageSha256, frozen.originalSha256],
    [report.workId, frozen.workId],
    [report.chapterId, frozen.chapterId],
    [report.blockCount, frozen.blockCount],
    [report.status, "completed"],
  ];
  if (scalarBindings.some(([actual, expected]) => actual !== expected)) {
    throw new Error(
      `Frozen run page ${frozen.selectionIndex} binding mismatch.`,
    );
  }
  /** @type {Array<[unknown,string]>} */
  const pathBindings = [
    [report.stagedOriginalImagePath, frozen.originalRelativePath],
    [report.cleanedImagePath, frozen.cleanedRelativePath],
    [report.fontInputPath, frozen.fontInputRelativePath],
  ];
  for (const [actual, relative] of pathBindings) {
    if (
      path.resolve(stringValue(actual)) !== resolveContained(runRoot, relative)
    ) {
      throw new Error(
        `Frozen run page ${frozen.selectionIndex} path mismatch.`,
      );
    }
  }
}

/** @param {string} parent @param {string} child */
function resolveContained(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(resolvedParent, child);
  const relative = path.relative(resolvedParent, resolvedChild);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return resolvedChild;
  }
  throw new Error(`Cleanup audit path escapes its frozen root: ${child}`);
}

/**
 * Shadow outputs and caches must remain disjoint from both the immutable
 * staged run and the user's source library. The two writable roots must also
 * be disjoint so cache creation cannot invalidate the empty artifact root.
 * @param {{root:string;runRoot:string;outputRoot:string;cacheDir:string}} options
 */
async function assertShadowWriteTargets(options) {
  const root = await canonicalizeProspectivePath(options.root);
  const runRoot = await canonicalizeProspectivePath(options.runRoot);
  const libraryRoot = await canonicalizeProspectivePath(
    path.join(options.root, "library"),
  );
  const outputRoot = await canonicalizeProspectivePath(options.outputRoot);
  const cacheDir = await canonicalizeProspectivePath(options.cacheDir);
  for (const [label, target] of [
    ["output", outputRoot],
    ["cache", cacheDir],
  ]) {
    if (
      target === root ||
      isAtOrWithin(runRoot, target) ||
      isAtOrWithin(libraryRoot, target)
    ) {
      throw new Error(
        `Cleanup audit ${label} must not write into the repository root, source library, or frozen run.`,
      );
    }
  }
  await Promise.all([
    assertNoProspectiveReparseRedirect(options.outputRoot, "output"),
    assertNoProspectiveReparseRedirect(options.cacheDir, "cache"),
  ]);
  if (
    isAtOrWithin(outputRoot, cacheDir) ||
    isAtOrWithin(cacheDir, outputRoot)
  ) {
    throw new Error(
      "Cleanup audit output and cache directories must be disjoint.",
    );
  }
}

/** @param {string} candidate @param {string} label */
async function assertNoProspectiveReparseRedirect(candidate, label) {
  let cursor = path.resolve(candidate);
  while (true) {
    try {
      const stat = await fsp.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Cleanup audit ${label} path contains a symlink/junction: ${cursor}`,
        );
      }
      const real = await fsp.realpath(cursor);
      if (normalizeComparablePath(real) !== normalizeComparablePath(cursor)) {
        throw new Error(
          `Cleanup audit ${label} path contains a reparse redirect: ${cursor}`,
        );
      }
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

/**
 * The Electron profile, server log, per-run scratch space, and live lock are
 * fixed beneath one repository-local shadow temp root. Existing path prefixes
 * must not contain symlinks, Windows junctions, or another realpath redirect.
 * Call this both before and after mkdir and again immediately before a temp
 * writer is invoked.
 * @param {{root:string;tempRoot:string;runRoot:string;userData:string;serverLog:string;lockPath:string}} options
 */
async function assertShadowRuntimeTargets(options) {
  const root = path.resolve(options.root);
  const expectedTempRoot = path.join(root, ".tmp", "gemma-cleanup-audit");
  const tempRoot = path.resolve(options.tempRoot);
  if (tempRoot !== expectedTempRoot) {
    throw new Error("Cleanup audit temp root differs from its fixed contract.");
  }
  const targets = [
    options.runRoot,
    options.userData,
    options.serverLog,
    options.lockPath,
  ].map((target) => path.resolve(target));
  if (targets.some((target) => !isAtOrWithin(tempRoot, target))) {
    throw new Error("Cleanup audit runtime path escapes its fixed temp root.");
  }
  await assertNoReparseRedirect(root, tempRoot);
  for (const target of targets) {
    await assertNoReparseRedirect(tempRoot, target);
  }
  const [canonicalRoot, canonicalTemp, ...canonicalTargets] = await Promise.all(
    [root, tempRoot, ...targets].map(canonicalizeProspectivePath),
  );
  if (
    !isAtOrWithin(canonicalRoot, canonicalTemp) ||
    canonicalTargets.some((target) => !isAtOrWithin(canonicalTemp, target))
  ) {
    throw new Error(
      "Cleanup audit runtime realpath escapes its fixed temp root.",
    );
  }
}

/** @param {string} anchor @param {string} target */
async function assertNoReparseRedirect(anchor, target) {
  const resolvedAnchor = path.resolve(anchor);
  const resolvedTarget = path.resolve(target);
  if (!isAtOrWithin(resolvedAnchor, resolvedTarget)) {
    throw new Error("Cleanup audit reparse check target escapes its anchor.");
  }
  const relative = path.relative(resolvedAnchor, resolvedTarget);
  let cursor = resolvedAnchor;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = await fsp.lstat(cursor);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Cleanup audit runtime path contains a symlink/junction: ${cursor}`,
      );
    }
    const real = await fsp.realpath(cursor);
    if (normalizeComparablePath(real) !== normalizeComparablePath(cursor)) {
      throw new Error(
        `Cleanup audit runtime path contains a reparse redirect: ${cursor}`,
      );
    }
  }
}

/** @param {string} value */
function normalizeComparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Resolve every existing prefix through realpath, then append only the missing
 * suffix. This catches directory symlinks and Windows junction/reparse points
 * both before and after mkdir without requiring the target to exist.
 * @param {string} candidate
 */
async function canonicalizeProspectivePath(candidate) {
  let cursor = path.resolve(candidate);
  /** @type {string[]} */
  const missing = [];
  while (true) {
    try {
      const real = await fsp.realpath(cursor);
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** @param {string} parent @param {string} candidate */
function isAtOrWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(
    error && typeof error === "object" && Reflect.get(error, "code") === code,
  );
}

/** @param {string} filePath @param {string} expected */
async function assertFileSha(filePath, expected) {
  const bytes = await fsp.readFile(filePath);
  if (sha256(bytes) !== expected) {
    throw new Error(`Frozen cleanup audit file hash mismatch: ${filePath}`);
  }
}

/** @param {string} filePath @returns {Promise<Record<string,unknown>>} */
async function readJson(filePath) {
  return /** @type {Record<string,unknown>} */ (
    JSON.parse(await fsp.readFile(filePath, "utf8"))
  );
}

/** @param {unknown} value @returns {unknown[]} */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value @returns {Record<string,unknown>} */
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string,unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {string} */
function stringValue(value) {
  return typeof value === "string" ? value : "";
}

module.exports = {
  FROZEN_MANIFEST_SHA256,
  FROZEN_MANIFEST_PATH,
  assertShadowWriteTargets,
  assertShadowRuntimeTargets,
  canonicalizeProspectivePath,
  detectExactImageMime,
  loadExactImage,
  loadFrozenAuditInputs,
  loadFrozenManifest,
  readImmutableBlocks,
  resolveContained,
  selectManifestPages,
  validateFrozenManifest,
};
