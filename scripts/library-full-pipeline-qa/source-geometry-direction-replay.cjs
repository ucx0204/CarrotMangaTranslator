// @ts-check
/* eslint-disable max-lines -- replay seal verification is kept beside its fail-closed artifact parser */

const nodeCrypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const EXPECTED_BASELINE_PAGE_COUNT = 40;
const RUN_SEAL_TOOL_ID = "manga-library-full-pipeline-font-qa-run-seal";
const RUN_SEAL_TOOL_VERSION = "1.1.0";
/** @type {WeakMap<BaselineSeal,Map<string,BaselinePageSeal>>} */
const verifiedBaselinePages = new WeakMap();

/**
 * @typedef {{contractVersion:"font-matching-ocr-candidate-membership-v2";source:"semantic_ocr_fixed_block_request_v5"|"semantic_ocr_fixed_block_request_v6"|"sealed_font_input_request_block_v2";bindingId:string;originalCandidateIds:number[];voterCandidateIds:number[]}} CandidateMembership
 * @typedef {{contractVersion:string;source:string;direction:"horizontal"|"vertical";candidateIds:number[];candidateMembership:CandidateMembership}} DirectionEvidence
 * @typedef {{readFontMatchingOcrGeometryDirection:(value:unknown,item:any,membership:unknown)=>DirectionEvidence|null;resolveFontMatchingOcrGeometryDirection:(item:any,hints:unknown)=>DirectionEvidence|undefined}} DirectionModule
 * @typedef {{kind:string;path:string;size:number;sha256:string}} SealBinding
 * @typedef {{path:string;sha256:string;artifactSource?:string;schemaVersion?:number;sourceLanguage?:string;providers?:string[];configurationSha256?:string;geometrySha256?:string;sourceBinding?:Record<string,unknown>}} RawArtifact
 * @typedef {{sourcePageId:string;fontInputBinding:SealBinding;rawOcrBindings:SealBinding[];expected:NonNullable<ReturnType<typeof readFontInputSourceBinding>>}} BaselinePageSeal
 * @typedef {{contractVersion:"font-replay-fresh-baseline-seal-v1";auditPath:string;auditSha256:string;expectedRunDir:string;pageCount:number}} BaselineSeal
 */

/**
 * Load and verify the precommitted fresh-Gemma baseline before replay begins.
 * Every one of the ordered 40 pages must have current, sealed font-input and
 * raw OCR bytes. The returned page map is code-owned and is rechecked again at
 * the per-page use boundary.
 *
 * @param {{auditPath:string;expectedRunDir:string;expectedPageIds:string[]}} options
 * @returns {Promise<BaselineSeal>}
 */
async function loadFontReplayBaselineSeal(options) {
  const expectedRunDir = path.resolve(options.expectedRunDir);
  const expectedPageIds = readExactPageIds(options.expectedPageIds);
  const auditPath = path.resolve(options.auditPath);
  const auditBytes = await fsp.readFile(auditPath);
  const auditSha256 = sha256Bytes(auditBytes);
  await assertAuditSidecar(auditPath, auditSha256);
  const audit = parseJson(auditBytes);
  assertFreshBaselineAuditIdentity(audit, expectedPageIds);

  const bindings = readSealBindings(audit.bindings);
  const bindingBytes = await validateCurrentSealBindings(bindings);
  assertFreshRunRootBinding(bindings, expectedRunDir);
  const globalBindings = indexSealBindings(bindings);
  const pages = Array.isArray(audit.pages) ? audit.pages : [];
  /** @type {Map<string,BaselinePageSeal>} */
  const pagesById = new Map();

  for (const [index, rawPage] of pages.entries()) {
    const pageSeal = await verifyFreshBaselinePage({
      bindingBytes,
      expectedPageIds,
      expectedRunDir,
      globalBindings,
      index,
      rawPage,
    });
    pagesById.set(pageSeal.sourcePageId, pageSeal);
  }
  if (pagesById.size !== EXPECTED_BASELINE_PAGE_COUNT) {
    throw new Error(
      "Fresh baseline seal does not cover exactly 40 unique pages.",
    );
  }
  const seal = Object.freeze({
    contractVersion: "font-replay-fresh-baseline-seal-v1",
    auditPath,
    auditSha256,
    expectedRunDir,
    pageCount: pagesById.size,
  });
  verifiedBaselinePages.set(seal, pagesById);
  return seal;
}

/**
 * @param {{bindingBytes:Map<string,Buffer>;expectedPageIds:string[];expectedRunDir:string;globalBindings:Map<string,SealBinding>;index:number;rawPage:any}} options
 * @returns {Promise<BaselinePageSeal>}
 */
async function verifyFreshBaselinePage(options) {
  const sourcePageId = options.expectedPageIds[options.index];
  if (!sourcePageId || options.rawPage?.sourcePageId !== sourcePageId) {
    throw new Error(
      `Fresh baseline audit page order does not match the replay cohort at ${options.index}: expected ${sourcePageId || "<missing>"}, got ${options.rawPage?.sourcePageId || "<missing>"}.`,
    );
  }
  const pageArtifacts = readSealBindings(options.rawPage.artifacts);
  const fontInputBindings = pageArtifacts.filter(
    (binding) => binding.kind === "font_input_json",
  );
  const rawOcrBindings = pageArtifacts.filter(
    (binding) => binding.kind === "raw_ocr_result_json",
  );
  if (fontInputBindings.length !== 1 || rawOcrBindings.length < 1) {
    throw new Error(
      `Fresh baseline page ${sourcePageId} must seal exactly one font-input and at least one raw OCR result.`,
    );
  }
  const fontInputBinding = fontInputBindings[0];
  if (!fontInputBinding) {
    throw new Error(
      `Fresh baseline page ${sourcePageId} seal inventory drifted.`,
    );
  }
  assertPageBindingInGlobalSeal(fontInputBinding, options.globalBindings);
  assertPathInside(options.expectedRunDir, fontInputBinding.path, "font-input");
  for (const rawOcrBinding of rawOcrBindings) {
    assertPageBindingInGlobalSeal(rawOcrBinding, options.globalBindings);
    assertPathInside(
      options.expectedRunDir,
      rawOcrBinding.path,
      "raw OCR result",
    );
  }

  const fontInput = parseJson(
    options.bindingBytes.get(bindingKey(fontInputBinding)),
  );
  const expected = readFontInputSourceBinding(
    fontInput,
    sourcePageId,
    fontInputBinding.path,
  );
  if (
    !expected ||
    String(options.rawPage.sourcePageSha256 ?? "").toLowerCase() !==
      expected.sourcePageSha256
  ) {
    throw new Error(
      `Fresh baseline page ${sourcePageId} font-input binding is invalid.`,
    );
  }
  await verifyRawOcrBindings({
    bindingBytes: options.bindingBytes,
    expected,
    rawOcrBindings,
    sourcePageId,
  });
  return { sourcePageId, fontInputBinding, rawOcrBindings, expected };
}

/**
 * @param {{bindingBytes:Map<string,Buffer>;expected:BaselinePageSeal["expected"];rawOcrBindings:SealBinding[];sourcePageId:string}} options
 */
async function verifyRawOcrBindings(options) {
  let canonicalRawGeometry = null;
  for (const rawOcrBinding of options.rawOcrBindings) {
    const rawResult = parseJson(
      options.bindingBytes.get(bindingKey(rawOcrBinding)),
    );
    if (!isRawOcrAnalysisResult(rawResult)) {
      throw new Error(
        `Fresh baseline page ${options.sourcePageId} raw OCR payload is invalid.`,
      );
    }
    const sourceBinding = await inspectRawSourceBinding(
      rawResult,
      options.expected,
      options.sourcePageId,
      rawOcrBinding.path,
    );
    if (sourceBinding.status !== "ready") {
      throw new Error(
        `Fresh baseline page ${options.sourcePageId} raw OCR source binding is not ready.`,
      );
    }
    const geometry = canonicalGeometryHints(rawResult.hints);
    if (canonicalRawGeometry !== null && geometry !== canonicalRawGeometry) {
      throw new Error(
        `Fresh baseline page ${options.sourcePageId} raw OCR geometry conflicts.`,
      );
    }
    canonicalRawGeometry = geometry;
  }
}

/**
 * Rebuild direction only from the sealed raw OCR geometry and the sealed
 * code-produced voter commitment. Cached/model-authored direction is ignored.
 *
 * @param {{baselineSeal:BaselineSeal;blocks:any[];fontInputPath:string;fontGeometryDirection:DirectionModule;pageId:string}} options
 */
async function attachFontReplaySourceGeometryDirections(options) {
  const pageSeal = readBaselinePageSeal(
    options.baselineSeal,
    options.pageId,
    options.fontInputPath,
  );
  const sealedInput = await loadSealedFontReplayInput(
    options.fontInputPath,
    options.pageId,
    options.blocks,
    pageSeal,
  );
  const raw = await loadPersistedFontReplayOcrHints(pageSeal);
  const sourceBlocks = sealedInput.blocks;
  let rawResolvedBlockCount = 0;
  const blocks = sourceBlocks.map((/** @type {any} */ entry) => {
    const membership = buildSealedFontInputMembership(entry);
    if (!membership) {
      throw new Error(
        `Sealed font-input block ${String(entry?.blockId ?? "<missing>")} has no trusted voter commitment.`,
      );
    }
    const boundItem = { ...entry.item, sourceCandidateMembership: membership };
    const evidence =
      options.fontGeometryDirection.resolveFontMatchingOcrGeometryDirection(
        boundItem,
        raw.hints,
      );
    if (!evidence) {
      throw new Error(
        `Sealed raw OCR geometry cannot resolve block ${String(entry.blockId)}.`,
      );
    }
    rawResolvedBlockCount += 1;
    const { sourceGeometryDirection: _cachedDirection, ...block } = entry;
    const { sourceCandidateMembership: _cachedMembership, ...item } =
      block.item;
    return {
      ...block,
      item,
      sourceCandidateMembership: membership,
      sourceGeometryDirection: evidence,
    };
  });
  return {
    blocks,
    audit: {
      contractVersion: "font-matching-ocr-geometry-replay-v1",
      rawArtifactStatus: "ready",
      rawArtifacts: raw.artifacts,
      fontInputBinding: sealedInput.audit,
      freshBaselineSeal: {
        path: options.baselineSeal.auditPath,
        sha256: options.baselineSeal.auditSha256,
        pageCount: options.baselineSeal.pageCount,
        profile: "fresh-gemma-full",
      },
      rawHintCount: raw.hints.length,
      blockCount: sourceBlocks.length,
      resolvedBlockCount: rawResolvedBlockCount,
      rawResolvedBlockCount,
      existingEvidenceResolvedBlockCount: 0,
      missingBlockCount: 0,
    },
  };
}

/** @param {BaselineSeal} seal @param {string} pageId @param {string} fontInputPath */
function readBaselinePageSeal(seal, pageId, fontInputPath) {
  const pagesById = seal ? verifiedBaselinePages.get(seal) : undefined;
  if (
    !seal ||
    seal.contractVersion !== "font-replay-fresh-baseline-seal-v1" ||
    seal.pageCount !== EXPECTED_BASELINE_PAGE_COUNT ||
    !pagesById
  ) {
    throw new Error(
      "A verified 40-page fresh baseline seal is required for font replay.",
    );
  }
  const page = pagesById.get(pageId);
  if (!page || !sameResolvedPath(page.fontInputBinding.path, fontInputPath)) {
    throw new Error(
      `Font replay page ${pageId} is not bound to the fresh baseline seal.`,
    );
  }
  return page;
}

/**
 * @param {string} fontInputPath
 * @param {string} pageId
 * @param {any[]} providedBlocks
 * @param {BaselinePageSeal} pageSeal
 */
async function loadSealedFontReplayInput(
  fontInputPath,
  pageId,
  providedBlocks,
  pageSeal,
) {
  const bytes = await readAndVerifyBinding(pageSeal.fontInputBinding);
  const parsed = parseJson(bytes);
  const binding = readFontInputSourceBinding(parsed, pageId, fontInputPath);
  const persistedBlocks = Array.isArray(parsed?.requestBlocks)
    ? parsed.requestBlocks
    : null;
  const blockInventoryMatches = Boolean(
    binding &&
    persistedBlocks &&
    validRequestBlockInventory(persistedBlocks) &&
    validRequestBlockInventory(providedBlocks) &&
    canonicalRequestBlockInventory(persistedBlocks) ===
      canonicalRequestBlockInventory(providedBlocks),
  );
  if (
    !binding ||
    !sameFontInputSourceBinding(binding, pageSeal.expected) ||
    !blockInventoryMatches
  ) {
    throw new Error(
      `Sealed font-input binding or request inventory drifted for ${pageId}.`,
    );
  }
  return {
    blocks: persistedBlocks,
    expected: binding,
    audit: {
      status: "ready",
      path: fontInputPath,
      sha256: pageSeal.fontInputBinding.sha256,
      sealedSha256: pageSeal.fontInputBinding.sha256,
      providedBlockInventoryMatches: true,
      expected: binding,
    },
  };
}

/** @param {any} value @param {string} requestedPageId @param {string} fontInputPath */
// eslint-disable-next-line complexity -- page identity, path, hash, and dimensions form one binding
function readFontInputSourceBinding(value, requestedPageId, fontInputPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const page = value.page;
  const sourcePageId = String(value.sourcePageId ?? "");
  const pageId = String(page?.id ?? "");
  const sourcePageSha256 = String(value.sourcePageSha256 ?? "").toLowerCase();
  const rawImagePath =
    typeof page?.imagePath === "string" ? page.imagePath : "";
  const imagePath = rawImagePath
    ? path.resolve(path.dirname(fontInputPath), rawImagePath)
    : "";
  const width = Number(page?.width);
  const height = Number(page?.height);
  if (
    sourcePageId !== requestedPageId ||
    pageId !== requestedPageId ||
    !/^[a-f0-9]{64}$/u.test(sourcePageSha256) ||
    !imagePath ||
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    return null;
  }
  return {
    requestedPageId,
    sourcePageId,
    pageId,
    sourcePageSha256,
    imagePath,
    width,
    height,
  };
}

/** @param {any[]} blocks */
function validRequestBlockInventory(blocks) {
  const blockIds = new Set();
  return blocks.every((block) => {
    const blockId = typeof block?.blockId === "string" ? block.blockId : "";
    const candidateIds = readItemCandidateIds(block?.item);
    if (!blockId || blockIds.has(blockId) || !candidateIds) return false;
    blockIds.add(blockId);
    return true;
  });
}

/** @param {any[]} blocks */
function canonicalRequestBlockInventory(blocks) {
  return JSON.stringify(
    blocks.map((block) => [
      block?.blockId ?? null,
      block?.item?.id ?? null,
      readItemCandidateIds(block?.item),
    ]),
  );
}

/**
 * Legacy fresh-v10 stored the code-produced voter list in its v1 direction
 * evidence. The sealed font-input bytes make that list immutable; the cached
 * direction itself is deliberately ignored.
 *
 * @param {any} entry @returns {CandidateMembership|null}
 */
function buildSealedFontInputMembership(entry) {
  const originalCandidateIds = readItemCandidateIds(entry?.item);
  const bindingId = typeof entry?.blockId === "string" ? entry.blockId : "";
  const voterCandidateIds = readSealedDirectionVoterCandidateIds(
    entry?.sourceGeometryDirection,
    originalCandidateIds,
  );
  return originalCandidateIds && voterCandidateIds && bindingId
    ? {
        contractVersion: "font-matching-ocr-candidate-membership-v2",
        source: "sealed_font_input_request_block_v2",
        bindingId,
        originalCandidateIds,
        voterCandidateIds,
      }
    : null;
}

/** @param {any} evidence @param {number[]|null} originalCandidateIds */
function readSealedDirectionVoterCandidateIds(evidence, originalCandidateIds) {
  if (
    !originalCandidateIds ||
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    evidence.source !== "semantic_ocr_candidate_bbox_majority"
  ) {
    return null;
  }
  const voters = readCandidateIdArray(evidence.candidateIds);
  if (!voters || !isOrderedSubset(voters, originalCandidateIds)) return null;
  if (evidence.contractVersion === "font-matching-ocr-geometry-direction-v1") {
    return voters;
  }
  const membership = evidence.candidateMembership;
  if (
    evidence.contractVersion !== "font-matching-ocr-geometry-direction-v2" ||
    !membership ||
    membership.contractVersion !==
      "font-matching-ocr-candidate-membership-v2" ||
    (membership.source !== "semantic_ocr_fixed_block_request_v5" &&
      membership.source !== "semantic_ocr_fixed_block_request_v6") ||
    !sameCandidateOrder(
      membership.originalCandidateIds,
      originalCandidateIds,
    ) ||
    !sameCandidateOrder(membership.voterCandidateIds, voters)
  ) {
    return null;
  }
  return voters;
}

/** @param {any} item */
function readItemCandidateIds(item) {
  return readCandidateIdArray(
    Array.isArray(item?.candidateIds) ? item.candidateIds : [item?.id],
  );
}

/** @param {unknown} value */
function readCandidateIdArray(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (candidateId) => Number.isInteger(candidateId) && candidateId > 0,
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value];
}

/** @param {readonly unknown[]} values @param {readonly unknown[]} inventory */
function isOrderedSubset(values, inventory) {
  let cursor = 0;
  for (const candidateId of inventory) {
    if (candidateId === values[cursor]) cursor += 1;
  }
  return cursor === values.length;
}

/** @param {unknown} left @param {unknown} right */
function sameCandidateOrder(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((candidateId, index) => candidateId === right[index])
  );
}

/** @param {BaselinePageSeal} pageSeal */
async function loadPersistedFontReplayOcrHints(pageSeal) {
  /** @type {any[]} */
  let hints = [];
  /** @type {RawArtifact[]} */
  const artifacts = [];
  for (const binding of pageSeal.rawOcrBindings) {
    const bytes = await readAndVerifyBinding(binding);
    const result = parseJson(bytes);
    if (!isRawOcrAnalysisResult(result)) {
      throw new Error(`Sealed raw OCR payload is invalid: ${binding.path}`);
    }
    const sourceBinding = await inspectRawSourceBinding(
      result,
      pageSeal.expected,
      pageSeal.sourcePageId,
      binding.path,
    );
    if (sourceBinding.status !== "ready") {
      throw new Error(`Sealed raw OCR source binding drifted: ${binding.path}`);
    }
    if (artifacts.length === 0) hints = result.hints;
    else if (
      canonicalGeometryHints(result.hints) !== canonicalGeometryHints(hints)
    ) {
      throw new Error(
        `Sealed raw OCR geometry conflicts for ${pageSeal.sourcePageId}.`,
      );
    }
    artifacts.push({
      path: binding.path,
      sha256: binding.sha256,
      artifactSource: "analysis_ocr_hints_result",
      schemaVersion: result.schemaVersion,
      sourceLanguage: result.sourceLanguage,
      providers: [
        ...new Set(
          result.diagnostics.map(
            (/** @type {{provider:string}} */ entry) => entry.provider,
          ),
        ),
      ],
      configurationSha256: sha256Bytes(
        Buffer.from(JSON.stringify(result.configuration)),
      ),
      geometrySha256: sha256Bytes(
        Buffer.from(canonicalGeometryHints(result.hints)),
      ),
      sourceBinding,
    });
  }
  if (artifacts.length === 0) {
    throw new Error(
      `Fresh baseline raw OCR is missing for ${pageSeal.sourcePageId}.`,
    );
  }
  return { status: "ready", hints, artifacts };
}

/**
 * @param {any} result
 * @param {NonNullable<ReturnType<typeof readFontInputSourceBinding>>} expected
 * @param {string} requestedPageId
 * @param {string} resultPath
 */
async function inspectRawSourceBinding(
  result,
  expected,
  requestedPageId,
  resultPath,
) {
  const rawImagePath = String(result.imagePath ?? "");
  const actualImagePath = rawImagePath
    ? path.resolve(path.dirname(resultPath), rawImagePath)
    : "";
  const actualWidth = Number(result.width);
  const actualHeight = Number(result.height);
  let actualImageSha256 = null;
  let imageReadError = null;
  try {
    actualImageSha256 = sha256Bytes(await fsp.readFile(actualImagePath));
  } catch (error) {
    imageReadError = readErrorCode(error);
  }
  const expectedResultPathSuffix = path.join(
    "ocr-hints",
    requestedPageId,
    "result.json",
  );
  const pageIdMatches =
    requestedPageId === expected.requestedPageId &&
    requestedPageId === expected.sourcePageId &&
    requestedPageId === expected.pageId &&
    path.normalize(resultPath).endsWith(expectedResultPathSuffix);
  const imagePathMatches = sameResolvedPath(
    actualImagePath,
    expected.imagePath,
  );
  const sha256Matches = actualImageSha256 === expected.sourcePageSha256;
  const dimensionsMatch =
    actualWidth === expected.width && actualHeight === expected.height;
  const status = imageReadError
    ? "invalid"
    : pageIdMatches && imagePathMatches && sha256Matches && dimensionsMatch
      ? "ready"
      : "conflict";
  return {
    status,
    expected: {
      pageId: expected.pageId,
      sourcePageId: expected.sourcePageId,
      sourcePageSha256: expected.sourcePageSha256,
      imagePath: expected.imagePath,
      width: expected.width,
      height: expected.height,
    },
    actual: {
      requestedPageId,
      imagePath: actualImagePath,
      imageSha256: actualImageSha256,
      width: actualWidth,
      height: actualHeight,
      resultPath,
    },
    pageIdMatches,
    imagePathMatches,
    sha256Matches,
    dimensionsMatch,
    ...(imageReadError ? { imageReadError } : {}),
  };
}

/** @param {any[]} pages */
function summarizeSourceGeometryDirectionReplay(pages) {
  const audits = pages
    .map((page) => page.sourceGeometryDirectionReplay)
    .filter(Boolean);
  /** @param {string} field */
  const sum = (field) =>
    audits.reduce((total, audit) => total + Number(audit[field] || 0), 0);
  /** @param {string} status */
  const statusCount = (status) =>
    audits.filter((audit) => audit.rawArtifactStatus === status).length;
  return {
    contractVersion: "font-matching-ocr-geometry-replay-summary-v1",
    pageCount: pages.length,
    auditedPageCount: audits.length,
    rawReadyPageCount: statusCount("ready"),
    rawMissingPageCount: statusCount("missing"),
    rawConflictPageCount: statusCount("conflict"),
    rawInvalidPageCount: statusCount("invalid"),
    blockCount: sum("blockCount"),
    resolvedBlockCount: sum("resolvedBlockCount"),
    rawResolvedBlockCount: sum("rawResolvedBlockCount"),
    existingEvidenceResolvedBlockCount: sum(
      "existingEvidenceResolvedBlockCount",
    ),
    missingBlockCount: sum("missingBlockCount"),
  };
}

/** @param {string[]} value */
function readExactPageIds(value) {
  if (
    !Array.isArray(value) ||
    value.length !== EXPECTED_BASELINE_PAGE_COUNT ||
    !value.every((pageId) => typeof pageId === "string" && pageId.length > 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Font replay requires the exact ordered 40-page cohort.");
  }
  return [...value];
}

/** @param {any} audit @param {string[]} expectedPageIds */
// eslint-disable-next-line complexity -- every fresh-run seal identity clause is mandatory
function assertFreshBaselineAuditIdentity(audit, expectedPageIds) {
  if (
    !audit ||
    typeof audit !== "object" ||
    Array.isArray(audit) ||
    audit.schemaVersion !== 1 ||
    audit.tool?.id !== RUN_SEAL_TOOL_ID ||
    audit.tool?.version !== RUN_SEAL_TOOL_VERSION ||
    audit.profile !== "fresh-gemma-full" ||
    audit.runIdentity?.cohort !== "baseline40" ||
    audit.runIdentity?.pageCount !== EXPECTED_BASELINE_PAGE_COUNT ||
    audit.execution?.provider !== "gemma" ||
    audit.execution?.cacheFrom !== null ||
    audit.execution?.pageMode !== "full" ||
    audit.execution?.fontInferenceMode !== "live_full_pipeline" ||
    audit.execution?.qaPageRelativeRoleReroute !== false ||
    !/^[a-f0-9]{64}$/u.test(String(audit.contentSha256 ?? "")) ||
    !Array.isArray(audit.pages) ||
    audit.pages.length !== expectedPageIds.length
  ) {
    throw new Error("Unsupported or incomplete fresh-Gemma baseline audit.");
  }
}

/** @param {unknown} value @returns {SealBinding[]} */
function readSealBindings(value) {
  if (!Array.isArray(value)) throw new Error("Run seal bindings are missing.");
  return value.map((raw) => {
    const binding = raw && typeof raw === "object" ? raw : {};
    const kind = typeof binding.kind === "string" ? binding.kind : "";
    const filePath = typeof binding.path === "string" ? binding.path : "";
    const size = Number(binding.size);
    const sha256 = String(binding.sha256 ?? "").toLowerCase();
    if (
      !kind ||
      !path.isAbsolute(filePath) ||
      !Number.isInteger(size) ||
      size < 0 ||
      !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      throw new Error("Run seal contains an invalid artifact binding.");
    }
    return { kind, path: filePath, size, sha256 };
  });
}

/** @param {SealBinding[]} bindings */
async function validateCurrentSealBindings(bindings) {
  const seen = new Set();
  const bytesByBinding = new Map();
  for (const binding of bindings) {
    const key = bindingKey(binding);
    if (seen.has(key))
      throw new Error("Run seal contains duplicate artifact bindings.");
    seen.add(key);
    bytesByBinding.set(key, await readAndVerifyBinding(binding));
  }
  return bytesByBinding;
}

/** @param {SealBinding} binding */
async function readAndVerifyBinding(binding) {
  const bytes = await fsp.readFile(binding.path);
  if (bytes.length !== binding.size || sha256Bytes(bytes) !== binding.sha256) {
    throw new Error(`Sealed artifact drifted: ${binding.path}`);
  }
  return bytes;
}

/** @param {SealBinding[]} bindings @param {string} expectedRunDir */
function assertFreshRunRootBinding(bindings, expectedRunDir) {
  const reports = bindings.filter(
    (binding) => binding.kind === "run_report_json",
  );
  const configs = bindings.filter(
    (binding) => binding.kind === "run_config_json",
  );
  if (
    reports.length !== 1 ||
    configs.length !== 1 ||
    !sameResolvedPath(path.dirname(reports[0].path), expectedRunDir) ||
    !sameResolvedPath(path.dirname(configs[0].path), expectedRunDir)
  ) {
    throw new Error("Fresh baseline audit is not bound to cache-from.");
  }
}

/** @param {SealBinding[]} bindings */
function indexSealBindings(bindings) {
  return new Map(bindings.map((binding) => [bindingKey(binding), binding]));
}

/** @param {SealBinding} binding @param {Map<string,SealBinding>} globals */
function assertPageBindingInGlobalSeal(binding, globals) {
  const global = globals.get(bindingKey(binding));
  if (!global || !sameSealBinding(binding, global)) {
    throw new Error(
      `Page artifact is not present in the global run seal: ${binding.path}`,
    );
  }
}

/** @param {SealBinding} binding */
function bindingKey(binding) {
  return `${binding.kind}\u0000${normalizeResolvedPath(binding.path)}`;
}

/** @param {SealBinding} left @param {SealBinding} right */
function sameSealBinding(left, right) {
  return (
    left.kind === right.kind &&
    sameResolvedPath(left.path, right.path) &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

/** @param {string} auditPath @param {string} auditSha256 */
async function assertAuditSidecar(auditPath, auditSha256) {
  const text = (await fsp.readFile(`${auditPath}.sha256`, "ascii")).trim();
  const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(text);
  if (
    !match ||
    match[1] !== auditSha256 ||
    match[2] !== path.basename(auditPath)
  ) {
    throw new Error("Fresh baseline audit SHA-256 sidecar is invalid.");
  }
}

/** @param {string} root @param {string} target @param {string} label */
function assertPathInside(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Sealed ${label} path is outside cache-from.`);
  }
}

/** @param {ReturnType<typeof readFontInputSourceBinding>} left @param {ReturnType<typeof readFontInputSourceBinding>} right */
function sameFontInputSourceBinding(left, right) {
  return Boolean(
    left &&
    right &&
    left.pageId === right.pageId &&
    left.sourcePageId === right.sourcePageId &&
    left.sourcePageSha256 === right.sourcePageSha256 &&
    sameResolvedPath(left.imagePath, right.imagePath) &&
    left.width === right.width &&
    left.height === right.height,
  );
}

/** @param {Buffer|undefined} bytes */
function parseJson(bytes) {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (_error) {
    return null;
  }
}

/** @param {any} result */
// eslint-disable-next-line complexity -- raw OCR provenance is one atomic fail-closed boundary
function isRawOcrAnalysisResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return false;
  return (
    Number.isInteger(result.schemaVersion) &&
    [9, 10].includes(result.schemaVersion) &&
    typeof result.imagePath === "string" &&
    result.imagePath.length > 0 &&
    Number.isFinite(result.width) &&
    result.width > 0 &&
    Number.isFinite(result.height) &&
    result.height > 0 &&
    result.sourceLanguage === "ja" &&
    result.configuration?.ocrBboxMode === "ocr" &&
    result.configuration?.ocrMergeMode === "semantic" &&
    Array.isArray(result.hints) &&
    Array.isArray(result.diagnostics) &&
    result.diagnostics.every(
      (/** @type {any} */ entry) => entry && typeof entry.provider === "string",
    ) &&
    typeof result.noTextDetected === "boolean" &&
    !("outputText" in result) &&
    !("rawResponse" in result) &&
    !("requestSummary" in result)
  );
}

/** @param {string} left @param {string} right */
function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  return normalizeResolvedPath(left) === normalizeResolvedPath(right);
}

/** @param {string} value */
function normalizeResolvedPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

/** @param {unknown} error */
function readErrorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "unknown";
}

/** @param {any[]} hints */
function canonicalGeometryHints(hints) {
  return JSON.stringify(
    hints
      .map((hint) => [
        hint?.id ?? null,
        hint?.x1 ?? null,
        hint?.y1 ?? null,
        hint?.x2 ?? null,
        hint?.y2 ?? null,
      ])
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
}

/** @param {Buffer} bytes */
function sha256Bytes(bytes) {
  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

module.exports = {
  attachFontReplaySourceGeometryDirections,
  loadFontReplayBaselineSeal,
  loadPersistedFontReplayOcrHints,
  summarizeSourceGeometryDirectionReplay,
};
