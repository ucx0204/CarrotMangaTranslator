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

const FONT_MATCHING_BUNDLE_DIRECTORY = "font-matching";
const DEFAULT_FONT_MATCHING_BUNDLE_RELATIVE = join(
  "artifacts",
  "font-matching-runtime-active21-r5-e1-release-v1",
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
      // trained runtime locally; on a fresh CI runner it is absent. The bundle
      // is externalized out of the installer (downloaded on first use via
      // src/main/pipeline/fontMatchingRuntimeAssets.ts and excluded from the
      // installer by the `!font-matching/**` extraResources filter), so a
      // missing default source is not a build error — staging is skipped.
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
      `[prepare-runtime] Font matching runtime bundle source is absent at ${bundleDir}; skipping staging (bundle is externalized, downloaded on first use).`,
    );
    return;
  }
  assertSafeBundleSource(options.root, options.outputDir, bundleDir);
  validateFontMatchingRuntimeBundle(bundleDir);
  const targetDir = join(options.outputDir, FONT_MATCHING_BUNDLE_DIRECTORY);
  mkdirSync(targetDir, { recursive: false });
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
  const contract = readJsonObject(
    join(bundleDir, FONT_MATCHING_CONTRACT_FILE),
    "runtime contract",
  );
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
 * Type declarations and Python bytecode caches support development but are
 * never read by the packaged runtime.
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
