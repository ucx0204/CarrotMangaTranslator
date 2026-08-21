/* eslint-disable max-lines -- cache replay and the mutually-bound artifact writer/validator stay together so the shadow audit seal has one implementation boundary */
// @ts-check

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  ARTIFACT_CONTRACT_VERSION,
  AUDIT_CONTRACT_VERSION,
  CACHE_CONTRACT_VERSION,
  CLEANUP_AUDIT_MAX_TOKENS,
  CLEANUP_AUDIT_SEED,
  INTEGRITY_SCOPE,
  MAX_REPAIR_ATTEMPTS,
  OFFICIAL_EMPTY_THOUGHT_PREFIX,
  OFFICIAL_EMPTY_THOUGHT_PREFIX_KIND,
  PROMPT_CONTRACT_VERSION,
  RESPONSE_FORMAT_DIALECT,
  RESPONSE_SCHEMA_VERSION,
  buildBlockAliasMap,
  buildCleanupAuditRepairPrompt,
  buildCleanupAuditRequestBody,
  buildExactTwoImageMessages,
  buildKnownBlockAuditPrompt,
  buildKnownBlockAuditResponseFormat,
  buildUnassignedAuditPrompt,
  buildUnassignedAuditResponseFormat,
  failClosedAuditResult,
  parseKnownBlockAuditOutput,
  parseUnassignedAuditOutput,
  sealRecord,
  sha256,
  sha256Canonical,
  verifySealedRecord,
} = require("./gemma-cleanup-audit-contract.cjs");

/** @typedef {{blockId:string;order:number;sourceText:string;translatedText:string;bbox1000:{x:number;y:number;w:number;h:number};bboxSpace:"normalized_1000";textRole:string}} AuditBlock */
/** @typedef {{selectionIndex:number;expectedClass:"clean"|"residual";pageId:string;workId:string;chapterId:string;originalPath:string;cleanedPath:string;fontInputPath:string;original:Record<string,any>;cleaned:Record<string,any>;fontInputSha256:string;blocks:AuditBlock[];orderedBlockIdsSha256:string;sourceRunStatus:string;sourceRunStatusSemantics:string}} AuditPageInput */
/** @typedef {{rawResponseText:string;outputText:string;finishReason:string}} RequestResult */
/** @typedef {(options:{passId:"known-block"|"unassigned-source";attemptNumber:number;requestBody:Record<string,unknown>;requestBodySha256:string})=>Promise<RequestResult>} AuditRequester */

/**
 * @param {{page:AuditPageInput;modelName:string;runtimeBinding:Record<string,unknown>}} options
 */
function prepareAuditPage(options) {
  const page = structuredClone(options.page);
  const runtimeBinding = structuredClone(options.runtimeBinding);
  if (verifySealedRecord(runtimeBinding).length > 0) {
    throw new Error("Cleanup audit runtime binding is not sealed.");
  }
  const blockIds = page.blocks.map((block) => block.blockId);
  const aliasMap = buildBlockAliasMap(blockIds);
  const knownBlockPrompt = buildKnownBlockAuditPrompt(page.blocks, aliasMap);
  const knownBlockResponseFormat = buildKnownBlockAuditResponseFormat(aliasMap);
  const unassignedPrompt = buildUnassignedAuditPrompt(page.blocks, aliasMap);
  const unassignedResponseFormat = buildUnassignedAuditResponseFormat();
  assertModelFacingContractUsesAliasesOnly(
    knownBlockPrompt,
    knownBlockResponseFormat,
    blockIds,
  );
  assertModelFacingContractUsesAliasesOnly(
    unassignedPrompt,
    unassignedResponseFormat,
    blockIds,
  );
  const knownBlockMessages = buildExactTwoImageMessages({
    original: /** @type {any} */ (page.original),
    cleaned: /** @type {any} */ (page.cleaned),
    prompt: knownBlockPrompt,
  });
  const knownBlockInitialRequestBody = buildCleanupAuditRequestBody({
    model: options.modelName,
    messages: knownBlockMessages,
    responseFormat: knownBlockResponseFormat,
  });
  const unassignedMessages = buildExactTwoImageMessages({
    original: /** @type {any} */ (page.original),
    cleaned: /** @type {any} */ (page.cleaned),
    prompt: unassignedPrompt,
  });
  const unassignedInitialRequestBody = buildCleanupAuditRequestBody({
    model: options.modelName,
    messages: unassignedMessages,
    responseFormat: unassignedResponseFormat,
  });
  const contractPins = buildPreparedContractPins({
    aliasMap,
    blocks: page.blocks,
    knownBlockPrompt,
    knownBlockResponseFormat,
    knownBlockInitialRequestBody,
    unassignedPrompt,
    unassignedResponseFormat,
    unassignedInitialRequestBody,
  });
  assertFrozenPageContractPins(page, contractPins);
  const inputBinding = sealRecord({
    contractVersion: AUDIT_CONTRACT_VERSION,
    promptContractVersion: PROMPT_CONTRACT_VERSION,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    shadowOnly: true,
    promotionEligible: false,
    evaluationRole: "development-only-not-holdout",
    holdoutEligible: false,
    integrityScope: INTEGRITY_SCOPE,
    productionMutationAllowed: false,
    page: {
      selectionIndex: page.selectionIndex,
      pageId: page.pageId,
      workId: page.workId,
      chapterId: page.chapterId,
      fontInputSha256: page.fontInputSha256,
      orderedBlockIdsSha256: page.orderedBlockIdsSha256,
      orderedBlockIds: blockIds,
      blockAliasMap: aliasMap,
      aliasToBlockIdSha256: contractPins.aliasToBlockIdSha256,
      blockIdToAliasSha256: contractPins.blockIdToAliasSha256,
      bbox1000ContractVersion: contractPins.bbox1000ContractVersion,
      bbox1000Sha256: contractPins.bbox1000Sha256,
    },
    images: [
      imageBinding(page.original, "Image1", page.originalPath),
      imageBinding(page.cleaned, "Image2", page.cleanedPath),
    ],
    modelName: options.modelName,
    runtimeBindingSha256: runtimeBinding.bindingSha256,
    passContracts: {
      knownBlock: {
        promptSha256: sha256(Buffer.from(knownBlockPrompt)),
        responseFormatSha256: sha256Canonical(knownBlockResponseFormat),
        initialRequestBodySha256: sha256Canonical(knownBlockInitialRequestBody),
        maximumRepairs: MAX_REPAIR_ATTEMPTS,
      },
      unassignedSource: {
        executionGate: "known-block-clean-only",
        reviewEvidenceOnly: true,
        productionMutationAllowed: false,
        promptSha256: sha256(Buffer.from(unassignedPrompt)),
        responseFormatSha256: sha256Canonical(unassignedResponseFormat),
        initialRequestBodySha256: sha256Canonical(unassignedInitialRequestBody),
        maximumRepairs: MAX_REPAIR_ATTEMPTS,
      },
    },
    responseFormatDialect: RESPONSE_FORMAT_DIALECT,
    outputControlPrefix: {
      kind: OFFICIAL_EMPTY_THOUGHT_PREFIX_KIND,
      sha256: sha256(Buffer.from(OFFICIAL_EMPTY_THOUGHT_PREFIX)),
      bytes: Buffer.byteLength(OFFICIAL_EMPTY_THOUGHT_PREFIX),
      exactPrefixOnly: true,
    },
    frozenContractPins: contractPins,
    generation: {
      seed: CLEANUP_AUDIT_SEED,
      maxTokens: CLEANUP_AUDIT_MAX_TOKENS,
      temperature: 0,
      topP: 1,
      topK: 1,
      cachePrompt: false,
      maximumRepairs: MAX_REPAIR_ATTEMPTS,
    },
  });
  const cacheKey = sha256Canonical({
    cacheContractVersion: CACHE_CONTRACT_VERSION,
    inputBindingSha256: inputBinding.bindingSha256,
    runtimeBindingSha256: runtimeBinding.bindingSha256,
  });
  const preparedSourceSha256 = sha256Canonical({
    page,
    modelName: options.modelName,
    runtimeBinding,
  });
  return deepFreeze({
    page,
    modelName: options.modelName,
    runtimeBinding,
    blockIds,
    aliasMap,
    basePrompt: knownBlockPrompt,
    responseFormat: knownBlockResponseFormat,
    initialRequestBody: knownBlockInitialRequestBody,
    knownBlockPrompt,
    knownBlockResponseFormat,
    knownBlockInitialRequestBody,
    unassignedPrompt,
    unassignedResponseFormat,
    unassignedInitialRequestBody,
    inputBinding,
    contractPins,
    cacheKey,
    preparedSourceSha256,
  });
}

/** @param {{aliasMap:Array<Record<string,any>>;blocks:AuditBlock[];knownBlockPrompt:string;knownBlockResponseFormat:Record<string,unknown>;knownBlockInitialRequestBody:Record<string,unknown>;unassignedPrompt:string;unassignedResponseFormat:Record<string,unknown>;unassignedInitialRequestBody:Record<string,unknown>}} options */
function buildPreparedContractPins(options) {
  const aliasToBlockId = options.aliasMap.map(({ alias, blockId, order }) => ({
    alias,
    blockId,
    order,
  }));
  const blockIdToAlias = options.aliasMap.map(({ alias, blockId, order }) => ({
    blockId,
    alias,
    order,
  }));
  return {
    contractVersion: AUDIT_CONTRACT_VERSION,
    promptContractVersion: PROMPT_CONTRACT_VERSION,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    responseFormatDialect: RESPONSE_FORMAT_DIALECT,
    aliasMapSha256: sha256Canonical(options.aliasMap),
    aliasToBlockIdSha256: sha256Canonical({
      direction: "alias-to-block-id",
      rows: aliasToBlockId,
    }),
    blockIdToAliasSha256: sha256Canonical({
      direction: "block-id-to-alias",
      rows: blockIdToAlias,
    }),
    bbox1000ContractVersion: "full-page-normalized-1000-top-left-v1",
    bbox1000Sha256: sha256Canonical(
      options.blocks.map(({ blockId, order, bbox1000, bboxSpace }) => ({
        blockId,
        order,
        bbox1000,
        bboxSpace,
      })),
    ),
    knownBlockPromptSha256: sha256(Buffer.from(options.knownBlockPrompt)),
    knownBlockResponseFormatSha256: sha256Canonical(
      options.knownBlockResponseFormat,
    ),
    knownBlockInitialRequestBodySha256: sha256Canonical(
      options.knownBlockInitialRequestBody,
    ),
    unassignedPromptSha256: sha256(Buffer.from(options.unassignedPrompt)),
    unassignedResponseFormatSha256: sha256Canonical(
      options.unassignedResponseFormat,
    ),
    unassignedInitialRequestBodySha256: sha256Canonical(
      options.unassignedInitialRequestBody,
    ),
    passOrder: ["known-block", "unassigned-source"],
    unassignedExecutionGate: "known-block-clean-only",
    unassignedEvidenceUse: "human-review-only-never-production-mutation",
    officialEmptyThoughtPrefixKind: OFFICIAL_EMPTY_THOUGHT_PREFIX_KIND,
    officialEmptyThoughtPrefixSha256: sha256(
      Buffer.from(OFFICIAL_EMPTY_THOUGHT_PREFIX),
    ),
    officialEmptyThoughtPrefixBytes: Buffer.byteLength(
      OFFICIAL_EMPTY_THOUGHT_PREFIX,
    ),
  };
}

/** @param {Record<string,any>} page @param {Record<string,unknown>} actual */
function assertFrozenPageContractPins(page, actual) {
  if (page.v4ContractPins === undefined) return;
  if (sha256Canonical(page.v4ContractPins) !== sha256Canonical(actual)) {
    throw new Error("Cleanup audit frozen v4 two-pass pins mismatch.");
  }
}

/** @param {string} prompt @param {Record<string,unknown>} responseFormat @param {string[]} blockIds */
function assertModelFacingContractUsesAliasesOnly(
  prompt,
  responseFormat,
  blockIds,
) {
  const schemaText = JSON.stringify(responseFormat);
  for (const blockId of blockIds) {
    if (prompt.includes(blockId) || schemaText.includes(blockId)) {
      throw new Error(
        "Cleanup audit model-facing prompt/schema leaked an immutable block ID.",
      );
    }
  }
}

/**
 * Rebuild every prepared byte-level contract. This runs before cache access and
 * immediately before every request, so a caller cannot reuse an old seal with
 * mutated images, blocks, model/runtime, prompt, schema, or body.
 * @param {ReturnType<typeof prepareAuditPage>} prepared
 */
function assertPreparedAuditPageIntegrity(prepared) {
  if (
    prepared.preparedSourceSha256 !==
    sha256Canonical({
      page: prepared.page,
      modelName: prepared.modelName,
      runtimeBinding: prepared.runtimeBinding,
    })
  ) {
    throw new Error(
      "Cleanup audit prepared source snapshot integrity mismatch.",
    );
  }
  const rebuilt = prepareAuditPage({
    page: structuredClone(prepared.page),
    modelName: prepared.modelName,
    runtimeBinding: structuredClone(prepared.runtimeBinding),
  });
  const fields = [
    "blockIds",
    "aliasMap",
    "basePrompt",
    "responseFormat",
    "initialRequestBody",
    "knownBlockPrompt",
    "knownBlockResponseFormat",
    "knownBlockInitialRequestBody",
    "unassignedPrompt",
    "unassignedResponseFormat",
    "unassignedInitialRequestBody",
    "inputBinding",
    "contractPins",
    "cacheKey",
  ];
  for (const field of fields) {
    if (
      sha256Canonical(Reflect.get(prepared, field)) !==
      sha256Canonical(Reflect.get(rebuilt, field))
    ) {
      throw new Error(`Cleanup audit prepared ${field} integrity mismatch.`);
    }
  }
  if (!isDeepFrozen(prepared)) {
    throw new Error("Cleanup audit prepared input is not immutable.");
  }
  return true;
}

/**
 * Execute one shadow audit. A cache hit is accepted only if both seals and the
 * exact prepared-input binding match. Schema failure after the initial request
 * plus two repair inferences becomes a deterministic uncertain decision.
 * @param {{prepared:ReturnType<typeof prepareAuditPage>;requester:AuditRequester;cacheDir?:string;writeGuard?:()=>Promise<void>}} options
 */
async function runAuditPage(options) {
  assertPreparedAuditPageIntegrity(options.prepared);
  const cached = options.cacheDir
    ? await readExactCache(
        options.cacheDir,
        options.prepared.cacheKey,
        options.prepared.inputBinding.bindingSha256,
        options.prepared,
      )
    : null;
  if (cached) return outcomeFromCache(options.prepared, cached);
  if (options.prepared.runtimeBinding.executionAllowed !== true) {
    throw new Error("Preflight-only runtime binding cannot execute Gemma.");
  }
  const knownBlockPass = await runAuditPass({
    prepared: options.prepared,
    requester: options.requester,
    passId: "known-block",
  });
  let unassignedSourcePass = null;
  if (
    knownBlockPass.executionStatus === "completed" &&
    knownBlockPass.parseContractSatisfied &&
    knownBlockPass.result?.status === "clean"
  ) {
    unassignedSourcePass = await runAuditPass({
      prepared: options.prepared,
      requester: options.requester,
      passId: "unassigned-source",
    });
  }
  const aggregate = composeTwoPassResult(knownBlockPass, unassignedSourcePass);
  const attempts = [
    ...knownBlockPass.attempts,
    ...(unassignedSourcePass?.attempts || []),
  ];
  const outcome = {
    page: options.prepared.page,
    prepared: options.prepared,
    cacheHit: false,
    executionStatus: aggregate.executionStatus,
    transportError: aggregate.transportError,
    parseContractSatisfied: aggregate.parseContractSatisfied,
    failClosed: aggregate.failClosed,
    result: aggregate.result,
    modelResult: knownBlockPass.modelResult,
    unassignedReviewEvidence: aggregate.unassignedReviewEvidence,
    passes: {
      knownBlock: knownBlockPass,
      unassignedSource: unassignedSourcePass,
    },
    attempts,
    recommendedDisposition:
      aggregate.result.status === "clean"
        ? "shadow-would-continue"
        : "shadow-would-pend-or-retry",
  };
  if (aggregate.executionStatus === "completed" && options.cacheDir) {
    await writeExactCache(
      options.cacheDir,
      buildCacheEntry(outcome),
      options.prepared,
      options.writeGuard,
    );
  }
  return outcome;
}

/**
 * @param {{prepared:ReturnType<typeof prepareAuditPage>;requester:AuditRequester;passId:"known-block"|"unassigned-source"}} options
 */
async function runAuditPass(options) {
  const attempts = [];
  const basePrompt = promptForPass(options.prepared, options.passId);
  let prompt = basePrompt;
  let successful = null;
  let executionStatus = "completed";
  let transportError = null;
  for (
    let attemptNumber = 1;
    attemptNumber <= MAX_REPAIR_ATTEMPTS + 1;
    attemptNumber += 1
  ) {
    assertPreparedAuditPageIntegrity(options.prepared);
    const request = buildAttemptRequest(
      options.prepared,
      prompt,
      options.passId,
    );
    let response;
    try {
      response = await options.requester({
        passId: options.passId,
        attemptNumber,
        requestBody: request.body,
        requestBodySha256: request.sha256,
      });
    } catch (error) {
      executionStatus = "failed";
      transportError = errorMessage(error);
      attempts.push({
        passId: options.passId,
        attemptNumber,
        promptSha256: sha256(Buffer.from(prompt)),
        requestBodySha256: request.sha256,
        rawResponseText: "",
        rawResponseSha256: sha256(""),
        outputText: "",
        outputTextSha256: sha256(""),
        finishReason: null,
        outputPrefixKind: "none",
        parseOk: false,
        parseErrors: ["request-failed"],
        transportError,
      });
      break;
    }
    assertRequesterResult(response);
    const parsed = parsePassOutput(
      options.passId,
      response.outputText,
      options.prepared.aliasMap,
      response.finishReason,
    );
    attempts.push({
      passId: options.passId,
      attemptNumber,
      promptSha256: sha256(Buffer.from(prompt)),
      requestBodySha256: request.sha256,
      rawResponseText: response.rawResponseText,
      rawResponseSha256: sha256(Buffer.from(response.rawResponseText)),
      outputText: response.outputText,
      outputTextSha256: sha256(Buffer.from(response.outputText)),
      finishReason: response.finishReason,
      outputPrefixKind: parsed.outputPrefixKind,
      parseOk: parsed.ok,
      parseErrors: parsed.errors,
      transportError: null,
    });
    if (parsed.ok) {
      successful = parsed;
      break;
    }
    if (attemptNumber <= MAX_REPAIR_ATTEMPTS) {
      prompt = buildCleanupAuditRepairPrompt(
        basePrompt,
        response.outputText,
        parsed.errors,
        attemptNumber,
        options.passId,
      );
    }
  }
  return {
    passId: options.passId,
    executionStatus,
    transportError,
    parseContractSatisfied: Boolean(successful?.ok),
    failClosed: !successful?.ok,
    modelResult: successful?.ok ? successful.modelResult : null,
    result:
      options.passId === "known-block" && successful?.ok
        ? Reflect.get(successful, "result")
        : null,
    attempts,
  };
}

/** @param {ReturnType<typeof runAuditPass> extends Promise<infer T> ? T : never} known @param {(ReturnType<typeof runAuditPass> extends Promise<infer T> ? T : never)|null} unassigned */
function composeTwoPassResult(known, unassigned) {
  const uncertain = failClosedAuditResult();
  if (
    known.executionStatus !== "completed" ||
    !known.parseContractSatisfied ||
    !known.result
  ) {
    return {
      executionStatus: known.executionStatus,
      transportError: known.transportError,
      parseContractSatisfied: false,
      failClosed: true,
      result: uncertain,
      unassignedReviewEvidence: null,
    };
  }
  if (known.result.status !== "clean") {
    return {
      executionStatus: "completed",
      transportError: null,
      parseContractSatisfied: true,
      failClosed: false,
      result: known.result,
      unassignedReviewEvidence: null,
    };
  }
  if (!unassigned) {
    return {
      executionStatus: "completed",
      transportError: null,
      parseContractSatisfied: false,
      failClosed: true,
      result: uncertain,
      unassignedReviewEvidence: null,
    };
  }
  if (
    unassigned.executionStatus !== "completed" ||
    !unassigned.parseContractSatisfied ||
    !unassigned.modelResult
  ) {
    return {
      executionStatus: unassigned.executionStatus,
      transportError: unassigned.transportError,
      parseContractSatisfied: false,
      failClosed: true,
      result: uncertain,
      unassignedReviewEvidence: null,
    };
  }
  const evidence = unassigned.modelResult;
  if (evidence.status === "residual") {
    return {
      executionStatus: "completed",
      transportError: null,
      parseContractSatisfied: true,
      failClosed: false,
      result: {
        status: "residual",
        reason: "unassigned_source_glyph_persists",
        evidenceBlockIds: [],
      },
      unassignedReviewEvidence: evidence,
    };
  }
  return {
    executionStatus: "completed",
    transportError: null,
    parseContractSatisfied: true,
    failClosed: false,
    result:
      evidence.status === "clean"
        ? {
            status: "clean",
            reason: "clean_no_source_glyphs",
            evidenceBlockIds: [],
          }
        : uncertain,
    unassignedReviewEvidence: null,
  };
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/** @param {unknown} value */
function isDeepFrozen(value) {
  if (!value || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}

/** @param {ReturnType<typeof prepareAuditPage>} prepared @param {"known-block"|"unassigned-source"} passId */
function promptForPass(prepared, passId) {
  return passId === "known-block"
    ? prepared.knownBlockPrompt
    : prepared.unassignedPrompt;
}

/** @param {ReturnType<typeof prepareAuditPage>} prepared @param {"known-block"|"unassigned-source"} passId */
function responseFormatForPass(prepared, passId) {
  return passId === "known-block"
    ? prepared.knownBlockResponseFormat
    : prepared.unassignedResponseFormat;
}

/** @param {"known-block"|"unassigned-source"} passId @param {string} outputText @param {Array<Record<string,any>>} aliasMap @param {string} finishReason */
function parsePassOutput(passId, outputText, aliasMap, finishReason) {
  return passId === "known-block"
    ? parseKnownBlockAuditOutput(
        outputText,
        /** @type {any} */ (aliasMap),
        finishReason,
      )
    : parseUnassignedAuditOutput(outputText, finishReason);
}

/** @param {ReturnType<typeof prepareAuditPage>} prepared @param {string} prompt @param {"known-block"|"unassigned-source"} [passId] */
function buildAttemptRequest(prepared, prompt, passId = "known-block") {
  const messages = buildExactTwoImageMessages({
    original: /** @type {any} */ (prepared.page.original),
    cleaned: /** @type {any} */ (prepared.page.cleaned),
    prompt,
  });
  const body = buildCleanupAuditRequestBody({
    model: prepared.modelName,
    messages,
    responseFormat: responseFormatForPass(prepared, passId),
  });
  return { body, sha256: sha256Canonical(body) };
}

/** @param {ReturnType<typeof runAuditPage> extends Promise<infer T> ? T : never} outcome */
function buildCacheEntry(outcome) {
  return sealRecord({
    contractVersion: CACHE_CONTRACT_VERSION,
    shadowOnly: true,
    promotionEligible: false,
    evaluationRole: "development-only-not-holdout",
    holdoutEligible: false,
    cacheKey: outcome.prepared.cacheKey,
    inputBindingSha256: outcome.prepared.inputBinding.bindingSha256,
    runtimeBindingSha256: outcome.prepared.runtimeBinding.bindingSha256,
    pageId: outcome.page.pageId,
    executionStatus: outcome.executionStatus,
    parseContractSatisfied: outcome.parseContractSatisfied,
    failClosed: outcome.failClosed,
    modelResult: outcome.modelResult,
    unassignedReviewEvidence: outcome.unassignedReviewEvidence,
    result: outcome.result,
    passes: outcome.passes,
    attempts: outcome.attempts,
  });
}

/** @param {string} cacheDir @param {string} cacheKey @param {unknown} inputBindingSha256 @param {ReturnType<typeof prepareAuditPage>} [prepared] */
async function readExactCache(
  cacheDir,
  cacheKey,
  inputBindingSha256,
  prepared,
) {
  const cachePath = exactCachePath(cacheDir, cacheKey);
  let text;
  try {
    text = await fsp.readFile(cachePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const entry = /** @type {Record<string,any>} */ (JSON.parse(text));
  const errors = verifyCacheEntry(
    entry,
    cacheKey,
    inputBindingSha256,
    prepared,
  );
  if (errors.length > 0) {
    throw new Error(
      `Cleanup audit cache validation failed: ${errors.join(", ")}`,
    );
  }
  return entry;
}

/** @param {string} cacheDir @param {Record<string,unknown>} entry @param {ReturnType<typeof prepareAuditPage>} [prepared] @param {()=>Promise<void>} [writeGuard] */
async function writeExactCache(cacheDir, entry, prepared, writeGuard) {
  const cacheKey = String(entry.cacheKey || "");
  const cachePath = exactCachePath(cacheDir, cacheKey);
  await writeGuard?.();
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  await writeGuard?.();
  const serialized = `${JSON.stringify(entry, null, 2)}\n`;
  try {
    await writeGuard?.();
    await fsp.writeFile(cachePath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
    await writeGuard?.();
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = await readExactCache(
      cacheDir,
      cacheKey,
      entry.inputBindingSha256,
      prepared,
    );
    if (sha256Canonical(existing) !== sha256Canonical(entry)) {
      throw new Error(
        "Cleanup audit cache key collision or concurrent mismatch.",
        { cause: error },
      );
    }
  }
  return cachePath;
}

/** @param {Record<string,any>} entry @param {string} cacheKey @param {unknown} inputBindingSha256 @param {ReturnType<typeof prepareAuditPage>} [prepared] */
function verifyCacheEntry(entry, cacheKey, inputBindingSha256, prepared) {
  const errors = verifySealedRecord(entry);
  if (entry.contractVersion !== CACHE_CONTRACT_VERSION)
    errors.push("contract-version");
  if (
    entry.shadowOnly !== true ||
    entry.promotionEligible !== false ||
    entry.evaluationRole !== "development-only-not-holdout" ||
    entry.holdoutEligible !== false
  ) {
    errors.push("safety-flags");
  }
  if (entry.cacheKey !== cacheKey) errors.push("cache-key");
  if (entry.inputBindingSha256 !== inputBindingSha256) {
    errors.push("input-binding");
  }
  if (entry.executionStatus !== "completed") errors.push("execution-status");
  if (!Array.isArray(entry.attempts) || !entry.result) {
    errors.push("payload");
  } else if (prepared) {
    if (entry.pageId !== prepared.page.pageId) errors.push("page-id");
    if (entry.runtimeBindingSha256 !== prepared.runtimeBinding.bindingSha256) {
      errors.push("runtime-binding");
    }
    validateCacheAttempts(entry, prepared, errors);
  }
  return errors;
}

/** @param {Record<string,any>} entry @param {ReturnType<typeof prepareAuditPage>} prepared @param {string[]} errors */
function validateCacheAttempts(entry, prepared, errors) {
  const storedPasses = entry.passes;
  if (!storedPasses || typeof storedPasses !== "object") {
    errors.push("passes-missing");
    return;
  }
  const known = replayPassAgainstPrepared(
    prepared,
    "known-block",
    storedPasses.knownBlock,
    errors,
    "known-block",
  );
  const shouldRunUnassigned =
    known.executionStatus === "completed" &&
    known.parseContractSatisfied &&
    known.result?.status === "clean";
  const storedUnassigned = storedPasses.unassignedSource ?? null;
  if (shouldRunUnassigned !== Boolean(storedUnassigned)) {
    errors.push("unassigned-execution-gate");
  }
  const unassigned = storedUnassigned
    ? replayPassAgainstPrepared(
        prepared,
        "unassigned-source",
        storedUnassigned,
        errors,
        "unassigned-source",
      )
    : null;
  const expectedAttempts = [...known.attempts, ...(unassigned?.attempts || [])];
  if (stableJson(entry.attempts) !== stableJson(expectedAttempts)) {
    errors.push("flat-attempt-inventory");
  }
  const aggregate = composeTwoPassResult(known, unassigned);
  if (
    entry.executionStatus !== aggregate.executionStatus ||
    entry.parseContractSatisfied !== aggregate.parseContractSatisfied ||
    entry.failClosed !== aggregate.failClosed ||
    stableJson(entry.modelResult) !== stableJson(known.modelResult) ||
    stableJson(entry.unassignedReviewEvidence) !==
      stableJson(aggregate.unassignedReviewEvidence) ||
    stableJson(entry.result) !== stableJson(aggregate.result)
  ) {
    errors.push("aggregate-result-binding");
  }
}

/**
 * @param {ReturnType<typeof prepareAuditPage>} prepared
 * @param {"known-block"|"unassigned-source"} passId
 * @param {Record<string,any>} stored
 * @param {string[]} errors
 * @param {string} prefix
 */
// eslint-disable-next-line complexity -- each pass is replayed from exact prompts, requests, responses, and terminal state
function replayPassAgainstPrepared(prepared, passId, stored, errors, prefix) {
  const attempts = Array.isArray(stored?.attempts) ? stored.attempts : [];
  if (stored?.passId !== passId) errors.push(`${prefix}-pass-id`);
  if (attempts.length < 1 || attempts.length > MAX_REPAIR_ATTEMPTS + 1) {
    errors.push(`${prefix}-attempt-count`);
  }
  const basePrompt = promptForPass(prepared, passId);
  let prompt = basePrompt;
  let successful = null;
  let transportError = null;
  for (const [index, attempt] of attempts.entries()) {
    const attemptNumber = index + 1;
    const request = buildAttemptRequest(prepared, prompt, passId);
    if (
      attempt.passId !== passId ||
      attempt.attemptNumber !== attemptNumber ||
      attempt.promptSha256 !== sha256(Buffer.from(prompt)) ||
      attempt.requestBodySha256 !== request.sha256
    ) {
      errors.push(`${prefix}-attempt-${attemptNumber}-request-binding`);
    }
    if (
      attempt.rawResponseSha256 !==
        sha256(Buffer.from(String(attempt.rawResponseText ?? ""))) ||
      attempt.outputTextSha256 !==
        sha256(Buffer.from(String(attempt.outputText ?? "")))
    ) {
      errors.push(`${prefix}-attempt-${attemptNumber}-response-binding`);
    }
    if (attempt.transportError !== null) {
      transportError = String(attempt.transportError || "");
      if (
        !transportError ||
        attempt.rawResponseText !== "" ||
        attempt.outputText !== "" ||
        attempt.finishReason !== null ||
        attempt.outputPrefixKind !== "none" ||
        attempt.parseOk !== false ||
        stableJson(attempt.parseErrors) !== stableJson(["request-failed"])
      ) {
        errors.push(`${prefix}-attempt-${attemptNumber}-transport-binding`);
      }
      if (index !== attempts.length - 1) {
        errors.push(`${prefix}-attempt-after-transport-error`);
      }
      break;
    }
    const parsed = parsePassOutput(
      passId,
      String(attempt.outputText ?? ""),
      prepared.aliasMap,
      String(attempt.finishReason ?? ""),
    );
    if (
      attempt.outputPrefixKind !== parsed.outputPrefixKind ||
      attempt.parseOk !== parsed.ok ||
      stableJson(attempt.parseErrors) !== stableJson(parsed.errors)
    ) {
      errors.push(`${prefix}-attempt-${attemptNumber}-parse-binding`);
    }
    if (parsed.ok) {
      successful = parsed;
      if (index !== attempts.length - 1) {
        errors.push(`${prefix}-attempt-after-success`);
      }
      break;
    }
    if (attemptNumber <= MAX_REPAIR_ATTEMPTS) {
      prompt = buildCleanupAuditRepairPrompt(
        basePrompt,
        String(attempt.outputText ?? ""),
        parsed.errors,
        attemptNumber,
        passId,
      );
    }
  }
  const derived = {
    passId,
    executionStatus: transportError ? "failed" : "completed",
    transportError,
    parseContractSatisfied: Boolean(successful?.ok),
    failClosed: !successful?.ok,
    modelResult: successful?.ok ? successful.modelResult : null,
    result:
      passId === "known-block" && successful?.ok
        ? Reflect.get(successful, "result")
        : null,
    attempts,
  };
  if (stableJson(stored) !== stableJson(derived)) {
    errors.push(`${prefix}-pass-result-binding`);
  }
  if (
    !transportError &&
    !successful?.ok &&
    attempts.length !== MAX_REPAIR_ATTEMPTS + 1
  ) {
    errors.push(`${prefix}-fail-closed-repair-cap`);
  }
  return derived;
}

/** @param {unknown} value */
function stableJson(value) {
  return JSON.stringify(value);
}

/**
 * @param {{outputRoot:string;outputAlreadyCreated?:boolean;sourceBinding:Record<string,unknown>;runtimeBinding:Record<string,unknown>;outcomes:Array<Awaited<ReturnType<typeof runAuditPage>>>;writeGuard?:()=>Promise<void>}} options
 */
async function writeExperimentArtifacts(options) {
  if (!options.outputAlreadyCreated) {
    await createExclusiveDirectory(options.outputRoot, options.writeGuard);
  } else {
    await options.writeGuard?.();
    await assertEmptyDirectory(options.outputRoot);
  }
  const pageRecords = [];
  for (const outcome of options.outcomes) {
    pageRecords.push(
      await writePageArtifact(options.outputRoot, outcome, options.writeGuard),
    );
  }
  const report = sealRecord({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    auditContractVersion: AUDIT_CONTRACT_VERSION,
    shadowOnly: true,
    promotionEligible: false,
    evaluationRole: "development-only-not-holdout",
    holdoutEligible: false,
    integrityScope: INTEGRITY_SCOPE,
    productionMutationAllowed: false,
    productionTranslationCompletionMutated: false,
    productionMaskMutated: false,
    productionRetryScheduled: false,
    sourceBinding: options.sourceBinding,
    runtimeBinding: options.runtimeBinding,
    expectedPageIds: options.outcomes.map((outcome) => outcome.page.pageId),
    expectedSelectionIndices: options.outcomes.map(
      (outcome) => outcome.page.selectionIndex,
    ),
    status: options.outcomes.every(
      (outcome) => outcome.executionStatus === "completed",
    )
      ? "completed"
      : "partial",
    pages: pageRecords,
    summary: summarizeOutcomes(options.outcomes),
  });
  await writeJsonExclusive(
    path.join(options.outputRoot, "report.json"),
    report,
    options.writeGuard,
  );
  return report;
}

/** @param {string} outputRoot @param {Awaited<ReturnType<typeof runAuditPage>>} outcome @param {()=>Promise<void>} [writeGuard] */
async function writePageArtifact(outputRoot, outcome, writeGuard) {
  const relativeDir = path.join(
    "pages",
    `selection-${String(outcome.page.selectionIndex).padStart(2, "0")}`,
  );
  const pageDir = path.join(outputRoot, relativeDir);
  await writeGuard?.();
  await fsp.mkdir(pageDir, { recursive: true });
  await writeGuard?.();
  const requestSummary = sealRecord({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    shadowOnly: true,
    pageId: outcome.page.pageId,
    cacheKey: outcome.prepared.cacheKey,
    inputBinding: outcome.prepared.inputBinding,
    runtimeBindingSha256: outcome.prepared.runtimeBinding.bindingSha256,
    exactTwoImageOrder: ["Image1:original", "Image2:cleaned"],
    passOrder: ["known-block", "unassigned-source"],
    unassignedExecutionGate: "known-block-clean-only",
    knownBlockInitialRequestBodySha256: sha256Canonical(
      outcome.prepared.knownBlockInitialRequestBody,
    ),
    unassignedInitialRequestBodySha256: sha256Canonical(
      outcome.prepared.unassignedInitialRequestBody,
    ),
  });
  const requestName = "request-receipt.json";
  const requestPath = path.join(pageDir, requestName);
  await writeJsonExclusive(requestPath, requestSummary, writeGuard);
  const attemptArtifacts = [];
  for (const attempt of outcome.attempts) {
    const name = `${attempt.passId}-attempt-${String(attempt.attemptNumber).padStart(2, "0")}.json`;
    const attemptPath = path.join(pageDir, name);
    await writeJsonExclusive(attemptPath, attempt, writeGuard);
    attemptArtifacts.push({
      path: name,
      sha256: await sha256File(attemptPath),
      passId: attempt.passId,
      attemptNumber: attempt.attemptNumber,
    });
  }
  const receipt = sealRecord({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    shadowOnly: true,
    promotionEligible: false,
    evaluationRole: "development-only-not-holdout",
    holdoutEligible: false,
    productionMutationAllowed: false,
    pageId: outcome.page.pageId,
    selectionIndex: outcome.page.selectionIndex,
    workId: outcome.page.workId,
    chapterId: outcome.page.chapterId,
    expectedClass: outcome.page.expectedClass,
    inputBindingSha256: outcome.prepared.inputBinding.bindingSha256,
    cacheKey: outcome.prepared.cacheKey,
    cacheHit: outcome.cacheHit,
    executionStatus: outcome.executionStatus,
    parseContractSatisfied: outcome.parseContractSatisfied,
    failClosed: outcome.failClosed,
    resultIdentifierKind: "immutable-block-ids",
    modelResult: outcome.modelResult,
    result: outcome.result,
    passes: outcome.passes,
    unassignedReviewEvidence: outcome.unassignedReviewEvidence,
    unassignedEvidenceUse: "human-review-only-never-production-mutation",
    recommendedDisposition: outcome.recommendedDisposition,
    transportError: outcome.transportError,
    requestArtifact: {
      path: requestName,
      sha256: await sha256File(requestPath),
    },
    attemptArtifacts,
  });
  const receiptName = "page-receipt.json";
  const receiptPath = path.join(pageDir, receiptName);
  await writeJsonExclusive(receiptPath, receipt, writeGuard);
  return {
    pageId: outcome.page.pageId,
    selectionIndex: outcome.page.selectionIndex,
    expectedClass: outcome.page.expectedClass,
    auditStatus: outcome.result.status,
    reason: outcome.result.reason,
    recommendedDisposition: outcome.recommendedDisposition,
    receiptPath: path.join(relativeDir, receiptName).replaceAll("\\", "/"),
    receiptSha256: await sha256File(receiptPath),
  };
}

/**
 * @param {string} outputRoot
 * @param {{allowPartial?:boolean;authoritativeInputs?:Record<string,any>;runtimeVerifier?:(binding:Record<string,any>, manifest:Record<string,any>)=>Promise<void>}} [options]
 */
// eslint-disable-next-line complexity -- report, child receipts, and frozen authority are one fail-closed validation transaction
async function validateExperimentArtifacts(outputRoot, options = {}) {
  const resolvedRoot = path.resolve(outputRoot);
  const reportPath = path.join(resolvedRoot, "report.json");
  const report = /** @type {Record<string,any>} */ (await readJson(reportPath));
  const errors = verifySealedRecord(report);
  if (report.contractVersion !== ARTIFACT_CONTRACT_VERSION) {
    errors.push("report-contract-version");
  }
  if (
    report.shadowOnly !== true ||
    report.promotionEligible !== false ||
    report.evaluationRole !== "development-only-not-holdout" ||
    report.holdoutEligible !== false ||
    report.productionMutationAllowed !== false ||
    report.productionTranslationCompletionMutated !== false ||
    report.productionMaskMutated !== false ||
    report.productionRetryScheduled !== false
  ) {
    errors.push("report-safety-flags");
  }
  if (
    sha256Canonical(report.integrityScope) !== sha256Canonical(INTEGRITY_SCOPE)
  ) {
    errors.push("report-integrity-scope");
  }
  errors.push(
    ...verifySealedRecord(report.sourceBinding).map(
      (error) => `source-binding-${error}`,
    ),
    ...verifySealedRecord(report.runtimeBinding).map(
      (error) => `runtime-binding-${error}`,
    ),
  );
  const pages = Array.isArray(report.pages) ? report.pages : [];
  if (
    pages.length !== arrayLength(report.expectedPageIds) ||
    pages.length !== arrayLength(report.expectedSelectionIndices)
  ) {
    errors.push("report-page-inventory");
  }
  if (
    stableJson(pages.map((page) => page.pageId)) !==
      stableJson(report.expectedPageIds) ||
    stableJson(pages.map((page) => page.selectionIndex)) !==
      stableJson(report.expectedSelectionIndices) ||
    new Set(pages.map((page) => page.pageId)).size !== pages.length
  ) {
    errors.push("report-page-order-or-membership");
  }
  const pageDetails = [];
  for (const page of pages) {
    const detail = await validatePageArtifact(resolvedRoot, page);
    errors.push(...detail.errors);
    pageDetails.push(detail);
  }
  const completed = pageDetails.every(
    (detail) => detail.receipt?.executionStatus === "completed",
  );
  const recomputedStatus = completed ? "completed" : "partial";
  if (report.status !== recomputedStatus)
    errors.push("report-status-recomputed");
  if (recomputedStatus !== "completed" && options.allowPartial !== true) {
    errors.push("partial-report-disallowed");
  }
  const summaryInputs = pageDetails
    .filter((detail) => detail.receipt)
    .map((detail) => {
      const receipt = /** @type {Record<string,any>} */ (detail.receipt);
      return {
        page: { expectedClass: detail.page.expectedClass },
        result: receipt.result,
        cacheHit: receipt.cacheHit,
        failClosed: receipt.failClosed,
      };
    });
  if (
    summaryInputs.length !== pages.length ||
    sha256Canonical(summarizeOutcomes(/** @type {any} */ (summaryInputs))) !==
      sha256Canonical(report.summary)
  ) {
    errors.push("report-summary-recomputed");
  }
  if (options.authoritativeInputs) {
    validateAuthoritativeArtifact(
      report,
      pageDetails,
      options.authoritativeInputs,
      errors,
    );
    if (options.runtimeVerifier) {
      try {
        await options.runtimeVerifier(
          report.runtimeBinding,
          options.authoritativeInputs.manifest,
        );
      } catch (error) {
        errors.push(`runtime-file-verification:${errorMessage(error)}`);
      }
    }
  } else {
    errors.push("authoritative-inputs-required");
  }
  if (errors.length > 0) {
    throw new Error(
      `Cleanup audit artifact validation failed: ${errors.join(", ")}`,
    );
  }
  return report;
}

/** @param {string} outputRoot */
async function readExperimentReport(outputRoot) {
  return /** @type {Record<string,any>} */ (
    await readJson(path.join(path.resolve(outputRoot), "report.json"))
  );
}

/** @param {string} outputRoot @param {any} page */
// eslint-disable-next-line complexity -- all referenced page files are bound at one artifact boundary
async function validatePageArtifact(outputRoot, page) {
  const errors = [];
  let receipt = null;
  let requestReceipt = null;
  /** @type {Array<Record<string,any>>} */
  const storedAttempts = [];
  const receiptPath = resolveArtifactPath(outputRoot, page.receiptPath);
  if ((await sha256File(receiptPath)) !== page.receiptSha256) {
    errors.push(`page-${page.selectionIndex}-receipt-file-sha`);
    return { page, errors, receipt, requestReceipt, attempts: storedAttempts };
  }
  receipt = /** @type {Record<string,any>} */ (await readJson(receiptPath));
  errors.push(
    ...verifySealedRecord(receipt).map(
      (error) => `page-${page.selectionIndex}-${error}`,
    ),
  );
  if (
    receipt.pageId !== page.pageId ||
    receipt.selectionIndex !== page.selectionIndex ||
    receipt.expectedClass !== page.expectedClass ||
    receipt.result?.status !== page.auditStatus ||
    receipt.result?.reason !== page.reason ||
    receipt.recommendedDisposition !== page.recommendedDisposition ||
    receipt.contractVersion !== ARTIFACT_CONTRACT_VERSION ||
    receipt.shadowOnly !== true ||
    receipt.promotionEligible !== false ||
    receipt.evaluationRole !== "development-only-not-holdout" ||
    receipt.holdoutEligible !== false ||
    receipt.productionMutationAllowed !== false ||
    receipt.resultIdentifierKind !== "immutable-block-ids" ||
    receipt.unassignedEvidenceUse !==
      "human-review-only-never-production-mutation"
  ) {
    errors.push(`page-${page.selectionIndex}-receipt-binding`);
  }
  const pageDir = path.dirname(receiptPath);
  const requestRecord = /** @type {Record<string,any>} */ (
    receipt.requestArtifact
  );
  const requestPath = resolveArtifactPath(pageDir, requestRecord.path);
  if ((await sha256File(requestPath)) !== requestRecord.sha256) {
    errors.push(`page-${page.selectionIndex}-referenced-file-sha`);
    return { page, errors, receipt, requestReceipt, attempts: storedAttempts };
  }
  requestReceipt = /** @type {Record<string,any>} */ (
    await readJson(requestPath)
  );
  errors.push(
    ...verifySealedRecord(requestReceipt).map(
      (error) => `page-${page.selectionIndex}-request-${error}`,
    ),
    ...verifySealedRecord(requestReceipt.inputBinding).map(
      (error) => `page-${page.selectionIndex}-input-${error}`,
    ),
  );
  if (
    requestReceipt.pageId !== page.pageId ||
    requestReceipt.inputBinding?.bindingSha256 !== receipt.inputBindingSha256
  ) {
    errors.push(`page-${page.selectionIndex}-request-binding`);
  }
  const blockIds = arrayValue(
    requestReceipt.inputBinding?.page?.orderedBlockIds,
  ).map(String);
  try {
    const aliasMap = buildBlockAliasMap(blockIds);
    const storedAliasMap = arrayValue(
      requestReceipt.inputBinding?.page?.blockAliasMap,
    );
    const aliasToBlockId = aliasMap.map(({ alias, blockId, order }) => ({
      alias,
      blockId,
      order,
    }));
    const blockIdToAlias = aliasMap.map(({ alias, blockId, order }) => ({
      blockId,
      alias,
      order,
    }));
    if (
      sha256Canonical(storedAliasMap) !== sha256Canonical(aliasMap) ||
      requestReceipt.inputBinding?.page?.aliasToBlockIdSha256 !==
        sha256Canonical({
          direction: "alias-to-block-id",
          rows: aliasToBlockId,
        }) ||
      requestReceipt.inputBinding?.page?.blockIdToAliasSha256 !==
        sha256Canonical({
          direction: "block-id-to-alias",
          rows: blockIdToAlias,
        })
    ) {
      errors.push(`page-${page.selectionIndex}-alias-bijection-binding`);
    }
  } catch (error) {
    errors.push(
      `page-${page.selectionIndex}-alias-bijection-invalid:${errorMessage(error)}`,
    );
  }
  for (const [index, artifact] of arrayValue(
    receipt.attemptArtifacts,
  ).entries()) {
    const record = /** @type {Record<string,any>} */ (artifact);
    const artifactPath = resolveArtifactPath(pageDir, record.path);
    if ((await sha256File(artifactPath)) !== record.sha256) {
      errors.push(`page-${page.selectionIndex}-referenced-file-sha`);
      continue;
    }
    const attempt = /** @type {Record<string,any>} */ (
      await readJson(artifactPath)
    );
    storedAttempts.push(attempt);
    if (
      record.passId !== attempt.passId ||
      record.attemptNumber !== attempt.attemptNumber ||
      !["known-block", "unassigned-source"].includes(attempt.passId)
    ) {
      errors.push(`page-${page.selectionIndex}-attempt-${index + 1}-inventory`);
    }
  }
  return { page, errors, receipt, requestReceipt, attempts: storedAttempts };
}

/**
 * Rebuild requests from the authoritative frozen images/blocks and compare the
 * whole request/input contract rather than trusting self-consistent artifacts.
 * @param {Record<string,any>} report
 * @param {Array<Record<string,any>>} pageDetails
 * @param {Record<string,any>} inputs
 * @param {string[]} errors
 */
// eslint-disable-next-line complexity -- every frozen source/request field is compared atomically to prevent resealed drift
function validateAuthoritativeArtifact(report, pageDetails, inputs, errors) {
  const source = /** @type {Record<string,any>} */ (report.sourceBinding);
  const authoritativePages = Array.isArray(inputs.pages) ? inputs.pages : [];
  const expectedIndices = authoritativePages.map((page) => page.selectionIndex);
  const expectedPageIds = authoritativePages.map((page) => page.pageId);
  const sourceChecks = [
    [source.frozenManifestSha256, inputs.manifestSha256],
    [source.runReportSha256, inputs.runReportSha256],
    [source.runConfigSha256, inputs.runConfigSha256],
    [source.manualLedgerSha256, inputs.ledgerSha256],
  ];
  if (
    report.evaluationRole !== inputs.manifest?.evaluationRole ||
    report.holdoutEligible !== inputs.manifest?.holdoutEligible ||
    sourceChecks.some(([actual, expected]) => actual !== expected) ||
    sha256Canonical(source.selectionIndices) !==
      sha256Canonical(expectedIndices) ||
    sha256Canonical(source.pageIds) !== sha256Canonical(expectedPageIds) ||
    sha256Canonical(report.expectedSelectionIndices) !==
      sha256Canonical(expectedIndices) ||
    sha256Canonical(report.expectedPageIds) !== sha256Canonical(expectedPageIds)
  ) {
    errors.push("authoritative-source-binding");
  }
  validateRuntimePins(report.runtimeBinding, inputs.manifest?.model, errors);
  if (pageDetails.length !== authoritativePages.length) {
    errors.push("authoritative-page-count");
    return;
  }
  for (const [index, detail] of pageDetails.entries()) {
    const page = authoritativePages[index];
    if (
      !detail.receipt ||
      !detail.requestReceipt ||
      detail.page.pageId !== page.pageId ||
      detail.page.selectionIndex !== page.selectionIndex ||
      detail.page.expectedClass !== page.expectedClass ||
      detail.receipt.workId !== page.workId ||
      detail.receipt.chapterId !== page.chapterId
    ) {
      errors.push(`page-${page.selectionIndex}-authoritative-inventory`);
      continue;
    }
    let prepared;
    try {
      prepared = prepareAuditPage({
        page,
        modelName: String(report.runtimeBinding?.modelName || ""),
        runtimeBinding: report.runtimeBinding,
      });
    } catch (error) {
      errors.push(
        `page-${page.selectionIndex}-authoritative-prepare:${errorMessage(error)}`,
      );
      continue;
    }
    const request = detail.requestReceipt;
    if (
      sha256Canonical(request.inputBinding) !==
        sha256Canonical(prepared.inputBinding) ||
      request.inputBinding?.bindingSha256 !==
        prepared.inputBinding.bindingSha256 ||
      request.cacheKey !== prepared.cacheKey ||
      detail.receipt.cacheKey !== prepared.cacheKey ||
      request.runtimeBindingSha256 !== report.runtimeBinding.bindingSha256 ||
      request.knownBlockInitialRequestBodySha256 !==
        sha256Canonical(prepared.knownBlockInitialRequestBody) ||
      request.unassignedInitialRequestBodySha256 !==
        sha256Canonical(prepared.unassignedInitialRequestBody) ||
      request.inputBinding?.passContracts?.knownBlock?.promptSha256 !==
        sha256(Buffer.from(prepared.knownBlockPrompt)) ||
      request.inputBinding?.passContracts?.knownBlock?.responseFormatSha256 !==
        sha256Canonical(prepared.knownBlockResponseFormat) ||
      request.inputBinding?.passContracts?.unassignedSource?.promptSha256 !==
        sha256(Buffer.from(prepared.unassignedPrompt)) ||
      request.inputBinding?.passContracts?.unassignedSource
        ?.responseFormatSha256 !==
        sha256Canonical(prepared.unassignedResponseFormat) ||
      stableJson(request.passOrder) !==
        stableJson(["known-block", "unassigned-source"]) ||
      request.unassignedExecutionGate !== "known-block-clean-only" ||
      sha256Canonical(request.exactTwoImageOrder) !==
        sha256Canonical(["Image1:original", "Image2:cleaned"])
    ) {
      errors.push(`page-${page.selectionIndex}-authoritative-request-binding`);
    }
    validateReceiptAgainstPrepared(
      page.selectionIndex,
      detail.receipt,
      detail.attempts,
      prepared,
      errors,
    );
  }
}

/** @param {number} selectionIndex @param {Record<string,any>} receipt @param {Array<Record<string,any>>} attempts @param {ReturnType<typeof prepareAuditPage>} prepared @param {string[]} errors */
function validateReceiptAgainstPrepared(
  selectionIndex,
  receipt,
  attempts,
  prepared,
  errors,
) {
  /** @type {string[]} */
  const replayErrors = [];
  validateCacheAttempts(
    {
      passes: receipt.passes,
      attempts,
      executionStatus: receipt.executionStatus,
      parseContractSatisfied: receipt.parseContractSatisfied,
      failClosed: receipt.failClosed,
      modelResult: receipt.modelResult,
      unassignedReviewEvidence: receipt.unassignedReviewEvidence,
      result: receipt.result,
    },
    prepared,
    replayErrors,
  );
  errors.push(
    ...replayErrors.map((error) => `page-${selectionIndex}-${error}`),
  );
}

/** @param {Record<string,any>} binding @param {Record<string,any>} model @param {string[]} errors */
// eslint-disable-next-line complexity -- all runtime pin fields jointly define the executable model identity
function validateRuntimePins(binding, model, errors) {
  if (
    binding?.bindingKind !== "live-local-gemma-runtime" ||
    binding?.executionAllowed !== true ||
    binding?.configuredModel?.repo !== model?.repo ||
    binding?.configuredModel?.file !== model?.file ||
    binding?.configuredModel?.revision !== model?.revision ||
    binding?.configuredModel?.expectedSha256 !== model?.expectedSha256 ||
    binding?.configuredModel?.mmproj?.repo !== model?.mmproj?.repo ||
    binding?.configuredModel?.mmproj?.file !== model?.mmproj?.file ||
    binding?.configuredModel?.mmproj?.revision !== model?.mmproj?.revision ||
    binding?.configuredModel?.mmproj?.expectedSha256 !==
      model?.mmproj?.expectedSha256 ||
    binding?.configuredModel?.chatTemplate?.revision !==
      model?.chatTemplate?.revision ||
    binding?.configuredModel?.chatTemplate?.expectedSha256 !==
      model?.chatTemplate?.expectedSha256 ||
    binding?.configuredModel?.chatTemplate?.expectedBytes !==
      model?.chatTemplate?.expectedBytes ||
    binding?.model?.sha256 !== model?.expectedSha256 ||
    binding?.mmproj?.sha256 !== model?.mmproj?.expectedSha256 ||
    binding?.chatTemplate?.sha256 !== model?.chatTemplate?.expectedSha256 ||
    binding?.chatTemplate?.bytes !== model?.chatTemplate?.expectedBytes ||
    binding?.chatTemplate?.revision !== model?.chatTemplate?.revision
  ) {
    errors.push("authoritative-runtime-pins");
  }
}

/** @param {Array<Awaited<ReturnType<typeof runAuditPage>>>} outcomes */
function summarizeOutcomes(outcomes) {
  /** @param {"clean"|"residual"|"uncertain"} status */
  const count = (status) =>
    outcomes.filter((outcome) => outcome.result.status === status).length;
  const correct = outcomes.filter((outcome) => {
    const predicted =
      outcome.result.status === "residual" ? "residual" : outcome.result.status;
    return predicted === outcome.page.expectedClass;
  }).length;
  return {
    pageCount: outcomes.length,
    clean: count("clean"),
    residual: count("residual"),
    uncertain: count("uncertain"),
    cacheHits: outcomes.filter((outcome) => outcome.cacheHit).length,
    parseFailClosed: outcomes.filter((outcome) => outcome.failClosed).length,
    frozenLabelExactMatches: correct,
    frozenLabelExactMatchRate: outcomes.length ? correct / outcomes.length : 0,
  };
}

/** @param {ReturnType<typeof prepareAuditPage>} prepared @param {Record<string,any>} cache */
function outcomeFromCache(prepared, cache) {
  return {
    page: prepared.page,
    prepared,
    cacheHit: true,
    executionStatus: cache.executionStatus,
    transportError: null,
    parseContractSatisfied: cache.parseContractSatisfied,
    failClosed: cache.failClosed,
    modelResult: structuredClone(cache.modelResult),
    unassignedReviewEvidence: structuredClone(cache.unassignedReviewEvidence),
    passes: structuredClone(cache.passes),
    result: structuredClone(cache.result),
    attempts: structuredClone(cache.attempts),
    recommendedDisposition:
      cache.result.status === "clean"
        ? "shadow-would-continue"
        : "shadow-would-pend-or-retry",
  };
}

/** @param {Record<string,any>} image @param {string} label @param {string} sourcePath */
function imageBinding(image, label, sourcePath) {
  return {
    label,
    role: image.role,
    sourcePath: path.resolve(sourcePath),
    sourceSha256: image.sourceSha256,
    sourceBytes: image.sourceBytes,
    payloadMime: image.mime,
    payloadSha256: image.payloadSha256,
    payloadBytes: image.payloadBytes,
    width: image.width,
    height: image.height,
  };
}

/** @param {string} root @param {()=>Promise<void>} [writeGuard] */
async function createExclusiveDirectory(root, writeGuard) {
  const resolved = path.resolve(root);
  await writeGuard?.();
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await writeGuard?.();
  try {
    await writeGuard?.();
    await fsp.mkdir(resolved);
    await writeGuard?.();
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(`Cleanup audit output already exists: ${resolved}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** @param {string} root */
async function assertEmptyDirectory(root) {
  const stat = await fsp.stat(root);
  if (!stat.isDirectory() || (await fsp.readdir(root)).length !== 0) {
    throw new Error(`Cleanup audit prepared output is not empty: ${root}`);
  }
}

/** @param {string} filePath @param {unknown} value @param {()=>Promise<void>} [writeGuard] */
async function writeJsonExclusive(filePath, value, writeGuard) {
  await writeGuard?.();
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await writeGuard?.();
}

/** @param {string} filePath */
async function sha256File(filePath) {
  return sha256(await fsp.readFile(filePath));
}

/** @param {string} cacheDir @param {string} cacheKey */
function exactCachePath(cacheDir, cacheKey) {
  if (!/^[a-f0-9]{64}$/u.test(cacheKey)) {
    throw new Error("Cleanup audit cache key is invalid.");
  }
  return path.join(path.resolve(cacheDir), `${cacheKey}.json`);
}

/** @param {string} root @param {unknown} relativePath */
function resolveArtifactPath(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath) {
    throw new Error("Cleanup audit artifact path is invalid.");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Cleanup audit artifact path escapes its root.");
  }
  return resolved;
}

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

/** @param {RequestResult} result */
function assertRequesterResult(result) {
  if (
    !result ||
    typeof result.rawResponseText !== "string" ||
    typeof result.outputText !== "string" ||
    typeof result.finishReason !== "string" ||
    !result.finishReason
  ) {
    throw new Error("Cleanup audit requester returned an invalid result.");
  }
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === "object"
    ? String(Reflect.get(error, "code") || "")
    : "";
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} value */
function arrayLength(value) {
  return Array.isArray(value) ? value.length : -1;
}

/** @param {unknown} value */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

module.exports = {
  assertPreparedAuditPageIntegrity,
  buildAttemptRequest,
  buildCacheEntry,
  buildPreparedContractPins,
  createExclusiveDirectory,
  exactCachePath,
  prepareAuditPage,
  readExperimentReport,
  readExactCache,
  runAuditPage,
  summarizeOutcomes,
  validateExperimentArtifacts,
  verifyCacheEntry,
  writeExactCache,
  writeExperimentArtifacts,
};
