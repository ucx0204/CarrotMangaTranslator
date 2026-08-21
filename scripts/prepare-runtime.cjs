const { createHash } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} = require("node:fs");
const { isAbsolute, join, relative, resolve } = require("node:path");
const {
  canonicalNestedRecordCoreFromJson,
} = require("./preserved-json-record-seal.cjs");

const FONT_MATCHING_BUNDLE_DIRECTORY = "font-matching";
const DEFAULT_FONT_MATCHING_BUNDLE_RELATIVE = join(
  "artifacts",
  "font-matching-runtime-active21-v9-r33-page-common-user-v3-release-v2",
);
const FONT_MATCHING_BUNDLE_FILES = [
  ".font-matching-runtime-artifact-owned.json",
  "auto-match-active-catalog.json",
  "encoder.onnx",
  "prototype-features.f32",
  "ranker.onnx",
  "runtime-contract.json",
  "selection-calibration.json",
].sort();
const FONT_MATCHING_MARKER_FILE = ".font-matching-runtime-artifact-owned.json";
const FONT_MATCHING_CONTRACT_FILE = "runtime-contract.json";
const FONT_MATCHING_RUNTIME_RECORD = "font_matching_runtime_artifact";
const FONT_MATCHING_RUNTIME_SCHEMA_V1 = "font-matching-runtime-artifact-v1";
const FONT_MATCHING_RUNTIME_SCHEMA_V2 = "font-matching-runtime-artifact-v2";
const FONT_MATCHING_RUNTIME_OWNER_V1 =
  "carrot-manga-translator/font-matching-runtime-artifact";
const FONT_MATCHING_RUNTIME_OWNER_V2 =
  "carrot-manga-translator/font-matching-runtime-artifact-v2";
const MANUAL_V2_ACCEPTANCE_SCHEMA =
  "font-matching-runtime-release-acceptance-v2";
const MANUAL_V2_ACCEPTANCE_RECORD_SHA256 =
  "c2418e72d42d85be87a67973e7bd4af8b3df46c5b16a2d717280496bfec0a7fd";
const MANUAL_V2_ACCEPTANCE_AUTHORITY =
  "explicit_user_approved_work_disjoint_fresh_gemma_manual_visual_review";
const MANUAL_V2_MODEL_VERSION = "manga-font-v8-active21-dfa42ae17f-ffb3285338";
const MANUAL_V2_RANKER_SHA256 =
  "dfa42ae17f340768cae30f2219973eae1ff62a4c3c1544496502621e6e710c78";
const R33_ACCEPTANCE_SCHEMA = "font-matching-runtime-release-acceptance-v3";
const R33_ACCEPTANCE_RECORD_SHA256 =
  "80be96c4314db4d89e4bc86ea6221ae2c5eae4b54226b64701e95fd1659c0140";
const R33_ACCEPTANCE_AUTHORITY =
  "explicit_user_approved_cached_page_ab_with_agent_visual_audit";
const R33_MODEL_VERSION = "manga-font-v9-r33-e049fc74c3ba";
const R33_RANKER_SHA256 =
  "e049fc74c3baeeee9aba179412a3b20387304b749936c167ecc753afcc78f4aa";
const HYBRID_BODY_ROLES = ["dialogue", "narration", "thought"];
const HYBRID_VARIANT_ROLES = [
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
  "other",
];
const HYBRID_ROUTING_KEYS = [
  "body_candidate_output",
  "body_roles",
  "candidate_scores_compatibility_alias",
  "role_source",
  "row_specific_rules",
  "schema_version",
  "selection_feature_dim",
  "selection_feature_source",
  "unknown_role_fallback",
  "variant_candidate_output",
  "variant_roles",
].sort();
const HYBRID_BATCHING_KEYS = [
  "encoder_batch_size",
  "parity_qualified",
  "ranker_batch_size",
].sort();

/**
 * @typedef {{
 *   root?: string;
 *   outputDir?: string;
 *   fontMatchingBundleDir?: string;
 *   runtimeModulesOnly?: boolean;
 * }} PrepareRuntimeAssetsOptions
 */

/** @param {PrepareRuntimeAssetsOptions} [options] */
function prepareRuntimeAssets(options = {}) {
  const root = options.root ?? join(__dirname, "..");
  const sourceDir = join(root, "src", "main", "runtime");
  const outputDir = options.outputDir ?? join(root, "out", "app-runtime");

  if (!existsSync(sourceDir)) {
    throw new Error(`Runtime source directory is missing: ${sourceDir}`);
  }

  assertSafeOutputDirectory(root, sourceDir, outputDir);
  emptyDirectory(outputDir);
  mkdirSync(outputDir, { recursive: true });
  copyDirectoryContents(sourceDir, outputDir);
  if (!options.runtimeModulesOnly) {
    const fontMatchingBundleDir =
      options.fontMatchingBundleDir ??
      resolveDefaultFontMatchingRuntimeBundleDir(root);
    stageFontMatchingRuntimeBundle({
      root,
      outputDir,
      bundleDir: fontMatchingBundleDir,
      // An explicitly selected bundle must exist (the operator asked for it).
      // The default bundle dir is only present on machines that have staged the
      // trained runtime locally; on a fresh CI runner it is absent. The four
      // small v2 trust/ranker files are still copied from src/main/runtime,
      // while the unchanged large assets are migrated or downloaded on first
      // use. A missing full source bundle is therefore not a build error.
      required: Boolean(options.fontMatchingBundleDir),
    });
  }

  return outputDir;
}

/** @param {string} root */
function resolveDefaultFontMatchingRuntimeBundleDir(root) {
  return join(root, DEFAULT_FONT_MATCHING_BUNDLE_RELATIVE);
}

/**
 * @param {{
 *   root: string;
 *   outputDir: string;
 *   bundleDir: string;
 *   required?: boolean;
 * }} options
 */
function stageFontMatchingRuntimeBundle(options) {
  const bundleDir = resolve(options.bundleDir);
  if (!existsSync(bundleDir)) {
    if (options.required) {
      throw new Error(`Font matching runtime bundle is missing: ${bundleDir}`);
    }
    console.log(
      `[prepare-runtime] Full font matching runtime source is absent at ${bundleDir}; keeping bundled v2 trust files and resolving shared large assets on first use.`,
    );
    return;
  }
  assertSafeBundleSource(options.root, options.outputDir, bundleDir);
  validateFontMatchingRuntimeBundle(bundleDir);
  const targetDir = join(options.outputDir, FONT_MATCHING_BUNDLE_DIRECTORY);
  // The source runtime tree carries the small v2 trust/ranker files so a
  // packaged app can assemble the cache without a second release endpoint.
  mkdirSync(targetDir, { recursive: true });
  for (const fileName of FONT_MATCHING_BUNDLE_FILES) {
    copyFileSync(join(bundleDir, fileName), join(targetDir, fileName));
  }
}

/**
 * @param {string} root
 * @param {string} outputDir
 * @param {string} bundleDir
 */
function assertSafeBundleSource(root, outputDir, bundleDir) {
  const resolvedRoot = resolve(root);
  const resolvedOutput = resolve(outputDir);
  if (
    !isStrictDescendant(resolvedRoot, bundleDir) ||
    isSameOrDescendant(resolvedOutput, bundleDir) ||
    isSameOrDescendant(bundleDir, resolvedOutput)
  ) {
    throw new Error(`Unsafe font matching runtime bundle source: ${bundleDir}`);
  }
}

/** @param {string} bundleDir */
function validateFontMatchingRuntimeBundle(bundleDir) {
  const rootStat = lstatSync(bundleDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      `Font matching runtime bundle must be a real directory: ${bundleDir}`,
    );
  }
  const entries = readdirSync(bundleDir, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    !sameOrder(names, FONT_MATCHING_BUNDLE_FILES)
  ) {
    throw new Error("Font matching runtime bundle inventory is invalid.");
  }
  const marker = readJsonObject(
    join(bundleDir, FONT_MATCHING_MARKER_FILE),
    "ownership marker",
  );
  if (
    Object.hasOwn(marker, "qa_only") ||
    Object.hasOwn(marker, "release_approved")
  ) {
    throw new Error(
      "Font matching QA-only runtime bundles cannot be packaged or deployed.",
    );
  }
  const expectedOwner = fontMatchingRuntimeOwner(marker.schema_version);
  if (
    !expectedOwner ||
    marker.owner !== expectedOwner ||
    marker.safe_replace !== true ||
    !isPlainObject(marker.artifacts)
  ) {
    throw new Error(
      "Font matching runtime bundle ownership marker is invalid.",
    );
  }
  const expectedArtifacts = FONT_MATCHING_BUNDLE_FILES.filter(
    (fileName) => fileName !== FONT_MATCHING_MARKER_FILE,
  );
  if (!sameOrder(Object.keys(marker.artifacts).sort(), expectedArtifacts)) {
    throw new Error(
      "Font matching runtime bundle marker inventory is invalid.",
    );
  }
  for (const fileName of expectedArtifacts) {
    const filePath = join(bundleDir, fileName);
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Font matching runtime artifact is not a real file: ${fileName}`,
      );
    }
    const actualSha = sha256File(filePath);
    if (marker.artifacts[fileName] !== actualSha) {
      throw new Error(
        `Font matching runtime artifact hash mismatch: ${fileName}`,
      );
    }
  }
  validateFontMatchingRuntimeContract(bundleDir, marker.schema_version);
}

/** @param {string} bundleDir */
function validatePackagedFontMatchingRuntimeBundle(bundleDir) {
  if (!existsSync(bundleDir)) {
    throw new Error(`Packaged font matching runtime is missing: ${bundleDir}`);
  }
  validateFontMatchingRuntimeBundle(bundleDir);
  const marker = readJsonObject(
    join(bundleDir, FONT_MATCHING_MARKER_FILE),
    "ownership marker",
  );
  if (marker.schema_version !== FONT_MATCHING_RUNTIME_SCHEMA_V2) {
    throw new Error(
      "Packaged font matching runtime must use the sealed schema-v2 release contract.",
    );
  }
}

/** @param {unknown} schema */
function fontMatchingRuntimeOwner(schema) {
  if (schema === FONT_MATCHING_RUNTIME_SCHEMA_V1) {
    return FONT_MATCHING_RUNTIME_OWNER_V1;
  }
  if (schema === FONT_MATCHING_RUNTIME_SCHEMA_V2) {
    return FONT_MATCHING_RUNTIME_OWNER_V2;
  }
  return null;
}

/**
 * @param {string} bundleDir
 * @param {unknown} markerSchema
 */
function validateFontMatchingRuntimeContract(bundleDir, markerSchema) {
  const contractPath = join(bundleDir, FONT_MATCHING_CONTRACT_FILE);
  const contractJson = readFileSync(contractPath, "utf8");
  const contract = readJsonObject(contractPath, "runtime contract");
  if (
    contract.schema_version !== markerSchema ||
    contract.record_type !== FONT_MATCHING_RUNTIME_RECORD
  ) {
    throw new Error(
      "Font matching runtime bundle marker/contract schema is invalid.",
    );
  }
  if (markerSchema === FONT_MATCHING_RUNTIME_SCHEMA_V1) {
    if (
      contract.hybrid_score_routing !== undefined ||
      contract.runtime_batching !== undefined
    ) {
      throw new Error(
        "Font matching v1 runtime contract contains hybrid-only fields.",
      );
    }
    return;
  }
  if (markerSchema !== FONT_MATCHING_RUNTIME_SCHEMA_V2) {
    throw new Error("Font matching runtime bundle schema is unsupported.");
  }
  if (!validHybridScoreRouting(contract.hybrid_score_routing)) {
    throw new Error(
      "Font matching v2 runtime hybrid score routing is invalid.",
    );
  }
  if (!validHybridRuntimeBatching(contract.runtime_batching)) {
    throw new Error("Font matching v2 runtime batching is invalid.");
  }
  if (!validReleaseAcceptance(contract, contractJson)) {
    throw new Error(
      "Font matching v2 production runtime release acceptance is invalid.",
    );
  }
}

/** @param {Record<string, unknown>} contract @param {string} contractJson */
function validReleaseAcceptance(contract, contractJson) {
  const acceptance = contract.release_acceptance;
  if (
    !isPlainObject(acceptance) ||
    !validReleaseAcceptanceSeal(acceptance, contractJson)
  ) {
    return false;
  }
  if (!validCommonReleaseAcceptance(acceptance)) return false;
  if (
    acceptance.schema_version === "font-matching-runtime-release-acceptance-v1"
  ) {
    if (!isPlainObject(acceptance.quality_gate)) return false;
    return (
      acceptance.automatic_visual_judgment === false &&
      validLegacyReleaseAcceptance(acceptance.quality_gate)
    );
  }
  if (acceptance.schema_version === R33_ACCEPTANCE_SCHEMA) {
    return validR33ReleaseAcceptance(contract, acceptance);
  }
  return validManualV2ReleaseAcceptance(contract, acceptance);
}

/** @param {Record<string, unknown>} acceptance */
function validCommonReleaseAcceptance(acceptance) {
  return Boolean(
    acceptance.record_type === "font_matching_runtime_release_acceptance" &&
    acceptance.status === "accepted" &&
    acceptance.external_release_quality_gate_passed === true &&
    typeof acceptance.automatic_visual_judgment === "boolean" &&
    isPlainObject(acceptance.quality_gate),
  );
}

/** @param {Record<string, unknown>} qualityGate */
function validLegacyReleaseAcceptance(qualityGate) {
  const verdicts = qualityGate.manual_page_verdicts;
  return Boolean(
    qualityGate.structural_error_count === 0 &&
    isPlainObject(verdicts) &&
    verdicts.accepted === 80 &&
    verdicts.total === 80,
  );
}

/**
 * @param {Record<string, unknown>} contract
 * @param {Record<string, unknown>} acceptance
 */
function validManualV2ReleaseAcceptance(contract, acceptance) {
  const qualityGate = acceptance.quality_gate;
  if (!isPlainObject(qualityGate)) return false;
  return Boolean(
    acceptance.schema_version === MANUAL_V2_ACCEPTANCE_SCHEMA &&
    acceptance.record_sha256 === MANUAL_V2_ACCEPTANCE_RECORD_SHA256 &&
    acceptance.acceptance_authority === MANUAL_V2_ACCEPTANCE_AUTHORITY &&
    acceptance.automatic_visual_judgment === false &&
    acceptance.explicit_user_acceptance === true &&
    contract.model_version === MANUAL_V2_MODEL_VERSION &&
    isPlainObject(contract.head) &&
    contract.head.onnx_sha256 === MANUAL_V2_RANKER_SHA256 &&
    isPlainObject(acceptance.evidence) &&
    acceptance.evidence.model_version === MANUAL_V2_MODEL_VERSION &&
    acceptance.evidence.ranker_sha256 === MANUAL_V2_RANKER_SHA256 &&
    qualityGate.calibration_release_quality_gate_passed === false &&
    qualityGate.usable_pages === 25 &&
    qualityGate.judged_content_pages === 30 &&
    qualityGate.structural_error_count === 0 &&
    qualityGate.outline_loss_count === 0 &&
    qualityGate.single_day_body_role_count === 0,
  );
}

/**
 * @param {Record<string, unknown>} contract
 * @param {Record<string, unknown>} acceptance
 */
// eslint-disable-next-line complexity -- every byte-pinned R33 release clause is mandatory
function validR33ReleaseAcceptance(contract, acceptance) {
  const qualityGate = acceptance.quality_gate;
  const evidence = acceptance.evidence;
  return Boolean(
    acceptance.record_sha256 === R33_ACCEPTANCE_RECORD_SHA256 &&
    acceptance.acceptance_authority === R33_ACCEPTANCE_AUTHORITY &&
    acceptance.automatic_visual_judgment === true &&
    acceptance.explicit_user_acceptance === true &&
    contract.model_version === R33_MODEL_VERSION &&
    isPlainObject(contract.head) &&
    contract.head.onnx_sha256 === R33_RANKER_SHA256 &&
    isPlainObject(evidence) &&
    evidence.model_version === R33_MODEL_VERSION &&
    evidence.ranker_sha256 === R33_RANKER_SHA256 &&
    isPlainObject(qualityGate) &&
    qualityGate.judged_content_pages === 5 &&
    qualityGate.live_font_replay_pages === 5 &&
    qualityGate.fresh_gemma_or_inpainting_pages === 0 &&
    qualityGate.improved_pages === 4 &&
    qualityGate.unchanged_pages === 1 &&
    qualityGate.regressed_pages === 0 &&
    qualityGate.outline_loss_count === 0 &&
    qualityGate.sfx_body_regression_count === 0 &&
    qualityGate.structural_error_count === 0 &&
    qualityGate.ranker_cpu_budget_passed === true &&
    qualityGate.ranker_cpu_budget_limit_multiplier === 2 &&
    qualityGate.gemma_or_inpainting_runs === 0,
  );
}

/** @param {Record<string, unknown>} acceptance @param {string} contractJson */
function validReleaseAcceptanceSeal(acceptance, contractJson) {
  if (!/^[a-f0-9]{64}$/u.test(String(acceptance.record_sha256 ?? ""))) {
    return false;
  }
  const canonicalCore = canonicalNestedRecordCoreFromJson(
    contractJson,
    "release_acceptance",
  );
  return Boolean(
    canonicalCore && sha256Text(canonicalCore) === acceptance.record_sha256,
  );
}

/** @param {string} value */
function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} value */
function validHybridScoreRouting(value) {
  if (
    !isPlainObject(value) ||
    !sameOrder(Object.keys(value).sort(), HYBRID_ROUTING_KEYS)
  ) {
    return false;
  }
  return (
    value.schema_version === "font-matching-hybrid-score-routing-v1" &&
    value.candidate_scores_compatibility_alias === "body_candidate_scores" &&
    value.body_candidate_output === "body_candidate_scores" &&
    value.variant_candidate_output === "variant_candidate_scores" &&
    sameStringArray(value.body_roles, HYBRID_BODY_ROLES) &&
    sameStringArray(value.variant_roles, HYBRID_VARIANT_ROLES) &&
    value.unknown_role_fallback === "variant_candidate_scores" &&
    value.role_source ===
      "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)" &&
    value.selection_feature_source ===
      "selected_candidate_scores_with_legacy256_visual_features" &&
    value.selection_feature_dim === 256 &&
    value.row_specific_rules === false
  );
}

/** @param {unknown} value */
function validHybridRuntimeBatching(value) {
  return Boolean(
    isPlainObject(value) &&
    sameOrder(Object.keys(value).sort(), HYBRID_BATCHING_KEYS) &&
    value.encoder_batch_size === 2 &&
    value.ranker_batch_size === 16 &&
    value.parity_qualified === true,
  );
}

/** @param {unknown} value @param {string[]} expected */
function sameStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    sameOrder(value, expected)
  );
}

/** @param {string} filePath @param {string} label */
function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Font matching runtime bundle ${label} is not valid JSON: ${filePath}`,
      { cause: error },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Font matching runtime bundle ${label} must be an object: ${filePath}`,
    );
  }
  return parsed;
}

/** @param {string} filePath */
function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string[]} left @param {string[]} right */
function sameOrder(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** @param {string} directory */
function emptyDirectory(directory) {
  if (!existsSync(directory)) {
    return;
  }
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime output must be a real directory: ${directory}`);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      emptyDirectory(entryPath);
      rmdirSync(entryPath);
      continue;
    }
    unlinkSync(entryPath);
  }
}

/**
 * @param {string} sourceDir
 * @param {string} outputDir
 */
function copyDirectoryContents(sourceDir, outputDir) {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (isDevelopmentRuntimeEntry(entry)) {
      continue;
    }
    const sourcePath = join(sourceDir, entry.name);
    const outputPath = join(outputDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(outputPath, { recursive: true });
      copyDirectoryContents(sourcePath, outputPath);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(sourcePath, outputPath);
    }
  }
}

/**
 * Type declarations, requirements compiler inputs, and Python bytecode caches
 * support development but are never read by the packaged runtime.
 *
 * @param {import("node:fs").Dirent} entry
 */
function isDevelopmentRuntimeEntry(entry) {
  return isDevelopmentRuntimePath(entry.name, entry.isDirectory());
}

/**
 * @param {string} relativePath
 * @param {boolean} [leafIsDirectory]
 */
function isDevelopmentRuntimePath(relativePath, leafIsDirectory = false) {
  const pathParts = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const name = pathParts.at(-1) ?? "";
  return (
    pathParts.includes("__pycache__") ||
    (!leafIsDirectory &&
      (name.endsWith(".d.ts") ||
        /^requirements-.*\.in$/.test(name) ||
        name.endsWith(".pyc") ||
        name.endsWith(".pyo")))
  );
}

/**
 * @param {string} root
 * @param {string} sourceDir
 * @param {string} outputDir
 */
function assertSafeOutputDirectory(root, sourceDir, outputDir) {
  const resolvedRoot = resolve(root);
  const resolvedSource = resolve(sourceDir);
  const resolvedOutput = resolve(outputDir);
  if (
    !isStrictDescendant(resolvedRoot, resolvedOutput) ||
    isSameOrDescendant(resolvedSource, resolvedOutput) ||
    isSameOrDescendant(resolvedOutput, resolvedSource)
  ) {
    throw new Error(`Refusing to clean unsafe runtime output: ${outputDir}`);
  }
}

/**
 * @param {string} parent
 * @param {string} candidate
 */
function isStrictDescendant(parent, candidate) {
  const child = relative(parent, candidate);
  return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
}

/**
 * @param {string} parent
 * @param {string} candidate
 */
function isSameOrDescendant(parent, candidate) {
  return (
    resolve(parent) === resolve(candidate) ||
    isStrictDescendant(parent, candidate)
  );
}

module.exports = {
  FONT_MATCHING_BUNDLE_DIRECTORY,
  FONT_MATCHING_BUNDLE_FILES,
  isDevelopmentRuntimePath,
  prepareRuntimeAssets,
  resolveDefaultFontMatchingRuntimeBundleDir,
  validateFontMatchingRuntimeBundle,
  validatePackagedFontMatchingRuntimeBundle,
};

if (require.main === module) {
  const outputDir = prepareRuntimeAssets();
  console.log(`[runtime] prepared ${outputDir}`);
}
