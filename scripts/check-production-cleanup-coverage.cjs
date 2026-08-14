// @ts-check

const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, statSync } = require("node:fs");
const { isAbsolute, join, posix, relative, resolve } = require("node:path");

const ROOT = join(__dirname, "..");
const DEFAULT_MANIFEST_PATH = join(
  __dirname,
  "production-cleanup-coverage-floors.json",
);
const DEFAULT_COVERAGE_PATH = join(ROOT, "coverage", "coverage-summary.json");
const CLEANUP_BASE_COMMIT = "01768a05a2e74666c1fd38f2b22e4efb1cf9822b";
const SCHEMA_VERSION = 2;
const COVERAGE_PROVIDER = "vitest-v8-json-summary";
const COVERAGE_METRICS = /** @type {const} */ ([
  "lines",
  "statements",
  "functions",
  "branches",
]);

/**
 * @typedef {"lines"|"statements"|"functions"|"branches"} CoverageMetricName
 * @typedef {{ total:number; covered:number; skipped:number; pct:number }} CoverageMetric
 * @typedef {{ total:number; covered:number; pct:number }} CoverageFloorMetric
 * @typedef {{ lines:CoverageFloorMetric; statements:CoverageFloorMetric; functions:CoverageFloorMetric; branches:CoverageFloorMetric }} CoverageFloor
 * @typedef {{
 *   baseCommit:string;
 *   baselinePlatform:"win32";
 *   coverageProvider:string;
 *   sourceArtifact:string;
 *   sourceArtifactSha256:string;
 *   introducedArtifact:string;
 *   introducedArtifactSha256:string;
 *   validatedNodeV8:string[];
 *   vitestVersion:string;
 *   coverageV8Version:string;
 * }} CoverageProvenance
 * @typedef {{
 *   schemaVersion:number;
 *   provenance:CoverageProvenance;
 *   floors:Record<string,CoverageFloor>;
 *   introducedFloors:Record<string,CoverageFloor>;
 *   deletedFiles:string[];
 * }} CoverageManifest
 * @typedef {{ existing:string[]; added:string[]; deleted:string[] }} CoverageScope
 */

/**
 * @param {{
 *   root?:string;
 *   manifestPath?:string;
 *   coveragePath?:string;
 *   platform?:NodeJS.Platform|string;
 *   collectScope?:(root:string,baseCommit:string)=>CoverageScope;
 * }} [options]
 */
function checkProductionCleanupCoverage(options = {}) {
  const root = resolve(options.root ?? ROOT);
  const manifestPath = resolve(options.manifestPath ?? DEFAULT_MANIFEST_PATH);
  const coveragePath = resolve(options.coveragePath ?? DEFAULT_COVERAGE_PATH);
  const manifest = loadCoverageManifest(root, manifestPath);
  const collectScope = options.collectScope ?? collectCoverageScope;
  const scope = collectScope(root, manifest.provenance.baseCommit);
  assertManifestCoversScope(manifest, scope);
  const coverage = loadCoverageSummary(root, coveragePath);
  const violations = [];
  const compareFloors =
    (options.platform ?? process.platform) ===
    manifest.provenance.baselinePlatform;

  const floorEntries = [
    ...Object.entries(manifest.floors),
    ...Object.entries(manifest.introducedFloors),
  ];
  for (const [file, floor] of floorEntries) {
    const record = readRequiredCoverageRecord(coverage, file);
    for (const metric of COVERAGE_METRICS) {
      const actual = readCoverageMetric(record, metric, file);
      const baseline = floor[metric];
      if (compareFloors && isCoverageRatioBelow(actual, baseline)) {
        violations.push(
          `${file} ${metric}: ${actual.pct}% (${actual.covered}/${actual.total}) below exact baseline ${baseline.pct}% (${baseline.covered}/${baseline.total})`,
        );
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Production cleanup coverage floors regressed:\n${violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  }
  return {
    baselinePlatform: manifest.provenance.baselinePlatform,
    comparedFloors: compareFloors,
    floorFiles: Object.keys(manifest.floors).length,
    introducedFloorFiles: Object.keys(manifest.introducedFloors).length,
    deletedFiles: manifest.deletedFiles.length,
  };
}

/** @param {string} root @param {string} manifestPath */
function loadCoverageManifest(root, manifestPath) {
  const value = readJsonFile(manifestPath, "coverage floor manifest");
  if (!isRecord(value)) {
    throw new Error("Coverage floor manifest must contain a JSON object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "provenance",
      "floors",
      "introducedFloors",
      "deletedFiles",
    ],
    "coverage floor manifest",
  );
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Coverage floor manifest schemaVersion is unsupported.");
  }
  const provenance = parseProvenance(value.provenance);
  assertCoverageToolchain(ROOT, provenance);
  const floors = parseCoverageFloorMap(root, value.floors, "floors");
  const introducedFloors = parseCoverageFloorMap(
    root,
    value.introducedFloors,
    "introducedFloors",
    true,
  );
  for (const file of Object.keys(introducedFloors)) {
    if (Object.hasOwn(floors, file)) {
      throw new Error(`Coverage file is listed twice: ${file}`);
    }
  }
  const deletedFiles = parseDeletedFiles(value.deletedFiles);
  for (const file of deletedFiles) {
    if (Object.hasOwn(floors, file) || Object.hasOwn(introducedFloors, file)) {
      throw new Error(`Coverage file is listed both live and deleted: ${file}`);
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    provenance,
    floors,
    introducedFloors,
    deletedFiles,
  };
}

/**
 * @param {string} root
 * @param {unknown} value
 * @param {string} field
 * @param {boolean} [allowEmpty]
 * @returns {Record<string,CoverageFloor>}
 */
function parseCoverageFloorMap(root, value, field, allowEmpty = false) {
  if (!isRecord(value) || (!allowEmpty && Object.keys(value).length === 0)) {
    throw new Error(`Coverage floor manifest ${field} must be non-empty.`);
  }
  const files = Object.keys(value);
  if (!sameStringArray(files, [...files].sort())) {
    throw new Error(`Coverage floor manifest ${field} must be sorted.`);
  }
  /** @type {Record<string,CoverageFloor>} */
  const result = {};
  for (const [file, rawFloor] of Object.entries(value)) {
    assertProductionCoveragePath(file);
    assertSourceFile(root, file);
    result[file] = parseCoverageFloor(rawFloor, file);
  }
  return result;
}

/** @param {unknown} value */
function parseDeletedFiles(value) {
  if (!Array.isArray(value)) {
    throw new Error("Coverage floor manifest deletedFiles must be an array.");
  }
  const files = value.map((file, index) => {
    if (typeof file !== "string") {
      throw new Error(
        `Coverage floor manifest deletedFiles[${index}] must be a string.`,
      );
    }
    assertProductionCoveragePath(file);
    return file;
  });
  if (
    new Set(files).size !== files.length ||
    !sameStringArray(files, [...files].sort())
  ) {
    throw new Error(
      "Coverage floor manifest deletedFiles must be unique and sorted.",
    );
  }
  return files;
}

/** @param {unknown} value @returns {CoverageProvenance} */
function parseProvenance(value) {
  if (!isRecord(value)) {
    throw new Error("Coverage floor manifest provenance must be an object.");
  }
  assertExactKeys(
    value,
    [
      "baseCommit",
      "baselinePlatform",
      "coverageProvider",
      "sourceArtifact",
      "sourceArtifactSha256",
      "introducedArtifact",
      "introducedArtifactSha256",
      "validatedNodeV8",
      "vitestVersion",
      "coverageV8Version",
    ],
    "coverage floor manifest provenance",
  );
  if (value.baseCommit !== CLEANUP_BASE_COMMIT) {
    throw new Error("Coverage floor manifest baseCommit is invalid.");
  }
  if (value.baselinePlatform !== "win32") {
    throw new Error("Coverage floor manifest baselinePlatform is invalid.");
  }
  if (value.coverageProvider !== COVERAGE_PROVIDER) {
    throw new Error("Coverage floor manifest coverageProvider is invalid.");
  }
  assertCoverageArtifact(
    "sourceArtifact",
    value.sourceArtifact,
    value.sourceArtifactSha256,
    /^\.tmp\/production-cleanup-coverage-baseline(?:-[a-z0-9-]+)?\.json$/,
  );
  assertCoverageArtifact(
    "introducedArtifact",
    value.introducedArtifact,
    value.introducedArtifactSha256,
    /^\.tmp\/production-cleanup-coverage-accepted-node\d+\.json$/,
  );
  assertValidatedNodeV8(value.validatedNodeV8);
  assertCoverageToolVersion("vitestVersion", value.vitestVersion);
  assertCoverageToolVersion("coverageV8Version", value.coverageV8Version);
  return /** @type {CoverageProvenance} */ (value);
}

/**
 * @param {"sourceArtifact"|"introducedArtifact"} field
 * @param {unknown} artifact
 * @param {unknown} sha256
 * @param {RegExp} allowedPath
 */
function assertCoverageArtifact(field, artifact, sha256, allowedPath) {
  if (
    typeof artifact !== "string" ||
    normalizeRepoPath(artifact) !== artifact ||
    !allowedPath.test(artifact)
  ) {
    throw new Error(`Coverage floor manifest ${field} is invalid.`);
  }
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Coverage floor manifest ${field}Sha256 is invalid.`);
  }
}

/** @param {unknown} value */
function assertValidatedNodeV8(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (runtime) =>
        typeof runtime !== "string" || !/^\d+\/\d+\.\d+$/.test(runtime),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Coverage floor manifest validatedNodeV8 is invalid.");
  }
}

/** @param {"vitestVersion"|"coverageV8Version"} field @param {unknown} value */
function assertCoverageToolVersion(field, value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Coverage floor manifest ${field} is invalid.`);
  }
}

/** @param {string} root @param {CoverageProvenance} provenance */
function assertCoverageToolchain(root, provenance) {
  const nodeMajor = process.versions.node.split(".")[0];
  const v8Family = process.versions.v8.split(".").slice(0, 2).join(".");
  const runtimeFamily = `${nodeMajor}/${v8Family}`;
  if (!provenance.validatedNodeV8.includes(runtimeFamily)) {
    throw new Error(
      `Coverage floor manifest has not been validated with Node/V8 ${runtimeFamily}.`,
    );
  }
  const vitestPackage = readJsonFile(
    join(root, "node_modules", "vitest", "package.json"),
    "Vitest package metadata",
  );
  const coveragePackage = readJsonFile(
    join(root, "node_modules", "@vitest", "coverage-v8", "package.json"),
    "Vitest V8 coverage package metadata",
  );
  if (
    !isRecord(vitestPackage) ||
    vitestPackage.version !== provenance.vitestVersion ||
    !isRecord(coveragePackage) ||
    coveragePackage.version !== provenance.coverageV8Version
  ) {
    throw new Error("Coverage floor manifest tool versions do not match.");
  }
}

/** @param {unknown} value @param {string} file @returns {CoverageFloor} */
function parseCoverageFloor(value, file) {
  if (!isRecord(value)) {
    throw new Error(`Coverage floor for ${file} must be an object.`);
  }
  assertExactKeys(value, [...COVERAGE_METRICS], `coverage floor for ${file}`);
  /** @type {Partial<CoverageFloor>} */
  const floor = {};
  for (const metric of COVERAGE_METRICS) {
    floor[metric] = parseCoverageFloorMetric(value[metric], file, metric);
  }
  return /** @type {CoverageFloor} */ (floor);
}

/**
 * @param {unknown} value
 * @param {string} file
 * @param {CoverageMetricName} metric
 * @returns {CoverageFloorMetric}
 */
function parseCoverageFloorMetric(value, file, metric) {
  const label = `coverage floor for ${file} ${metric}`;
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(value, ["total", "covered", "pct"], label);
  const counts = parseCoveredTotalPercent(value, label);
  return {
    total: counts.total,
    covered: counts.covered,
    pct: counts.pct,
  };
}

/** @param {string} root @param {string} coveragePath */
function loadCoverageSummary(root, coveragePath) {
  const value = readJsonFile(coveragePath, "coverage summary");
  if (!isRecord(value) || !isRecord(value.total)) {
    throw new Error("Coverage summary must contain a total record.");
  }
  for (const metric of COVERAGE_METRICS) {
    readCoveragePercent(value.total, metric, "total");
  }
  /** @type {Map<string,Record<string,unknown>>} */
  const records = new Map();
  for (const [file, record] of Object.entries(value)) {
    if (file === "total") continue;
    const relativeFile = toRepoRelativeCoveragePath(root, file);
    if (!relativeFile) continue;
    if (!isRecord(record)) {
      throw new Error(`Coverage record for ${relativeFile} is invalid.`);
    }
    if (records.has(relativeFile)) {
      throw new Error(
        `Coverage summary contains duplicate file: ${relativeFile}`,
      );
    }
    records.set(relativeFile, record);
  }
  return records;
}

/** @param {Map<string,Record<string,unknown>>} coverage @param {string} file */
function readRequiredCoverageRecord(coverage, file) {
  const record = coverage.get(file);
  if (!record) {
    throw new Error(`Coverage summary is missing required file: ${file}`);
  }
  return record;
}

/**
 * @param {Record<string,unknown>} record
 * @param {CoverageMetricName} metric
 * @param {string} label
 */
function readCoveragePercent(record, metric, label) {
  return readCoverageMetric(record, metric, label).pct;
}

/**
 * @param {Record<string,unknown>} record
 * @param {CoverageMetricName} metric
 * @param {string} label
 * @returns {CoverageMetric}
 */
function readCoverageMetric(record, metric, label) {
  const value = record[metric];
  if (!isRecord(value)) {
    throw new Error(`Coverage record ${label} is missing metric ${metric}.`);
  }
  const counts = parseCoveredTotalPercent(
    value,
    `coverage metric ${label} ${metric}`,
  );
  const skipped = value.skipped;
  if (
    typeof skipped !== "number" ||
    !Number.isSafeInteger(skipped) ||
    skipped < 0 ||
    skipped > counts.total ||
    counts.covered > counts.total - skipped
  ) {
    throw new Error(`Coverage metric ${label} ${metric} is invalid.`);
  }
  return { ...counts, skipped };
}

/**
 * @param {Record<string,unknown>} value
 * @param {string} label
 * @returns {{total:number;covered:number;pct:number}}
 */
function parseCoveredTotalPercent(value, label) {
  const total = value.total;
  const covered = value.covered;
  const pct = value.pct;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    typeof covered !== "number" ||
    !Number.isSafeInteger(covered) ||
    covered < 0 ||
    covered > total ||
    typeof pct !== "number" ||
    !Number.isFinite(pct) ||
    pct < 0 ||
    pct > 100
  ) {
    throw new Error(`${label} is invalid.`);
  }
  // Match istanbul-lib-coverage exactly. Multiplying before dividing avoids
  // binary floating-point underflow such as 57 / 100 becoming 56.99.
  const expectedPct =
    total === 0 ? 100 : Math.floor((1000 * 100 * covered) / total / 10) / 100;
  if (pct !== expectedPct) {
    throw new Error(`${label} pct does not match its counts.`);
  }
  return { total, covered, pct };
}

/**
 * @param {CoverageMetric} actual
 * @param {CoverageFloorMetric} baseline
 */
function isCoverageRatioBelow(actual, baseline) {
  if (baseline.total === 0) {
    return actual.covered !== actual.total;
  }
  if (actual.total === 0) return true;
  return (
    BigInt(actual.covered) * BigInt(baseline.total) <
    BigInt(baseline.covered) * BigInt(actual.total)
  );
}

/** @param {string} root @param {string} baseCommit @returns {CoverageScope} */
function collectCoverageScope(root, baseCommit) {
  let diffOutput;
  let untrackedOutput;
  try {
    diffOutput = execFileSync(
      "git",
      ["diff", "--name-status", "--no-renames", "-z", baseCommit, "--", "src"],
      { cwd: root, encoding: "utf8" },
    );
    untrackedOutput = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z", "--", "src"],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(
      `Cannot derive production cleanup coverage scope from ${baseCommit}.`,
      { cause: error },
    );
  }
  return parseCoverageStatusOutput(diffOutput, untrackedOutput);
}

/**
 * @param {string} diffOutput
 * @param {string} untrackedOutput
 * @returns {CoverageScope}
 */
function parseCoverageStatusOutput(diffOutput, untrackedOutput) {
  /** @type {Set<string>} */
  const existing = new Set();
  /** @type {Set<string>} */
  const added = new Set();
  /** @type {Set<string>} */
  const deleted = new Set();
  const diffFields = splitNullTerminated(diffOutput, "git diff");
  if (diffFields.length % 2 !== 0) {
    throw new Error("Cannot parse production cleanup source status output.");
  }
  for (let index = 0; index < diffFields.length; index += 2) {
    const status = diffFields[index];
    const normalized = normalizeRepoPath(diffFields[index + 1]);
    if (!isProductionCoveragePath(normalized)) continue;
    if (status === "M") existing.add(normalized);
    else if (status === "A") added.add(normalized);
    else if (status === "D") deleted.add(normalized);
    else {
      throw new Error(
        `Unsupported production cleanup source status ${status}: ${normalized}`,
      );
    }
  }
  for (const file of splitNullTerminated(untrackedOutput, "git ls-files")) {
    const normalized = normalizeRepoPath(file);
    if (isProductionCoveragePath(normalized)) added.add(normalized);
  }
  return {
    existing: [...existing].sort(),
    added: [...added].sort(),
    deleted: [...deleted].sort(),
  };
}

/** @param {string} value @param {string} label */
function splitNullTerminated(value, label) {
  if (value === "") return [];
  if (!value.endsWith("\0")) {
    throw new Error(`${label} output is not NUL-terminated.`);
  }
  return value.slice(0, -1).split("\0");
}

/** @param {CoverageManifest} manifest @param {CoverageScope} scope */
function assertManifestCoversScope(manifest, scope) {
  const floorFiles = Object.keys(manifest.floors).sort();
  const introducedFloorFiles = Object.keys(manifest.introducedFloors).sort();
  const deletedFiles = [...manifest.deletedFiles].sort();
  /** @type {string[]} */
  const problems = [];
  appendSetDifference(
    problems,
    "missing existing floor",
    scope.existing,
    floorFiles,
  );
  appendSetDifference(
    problems,
    "stale existing floor",
    floorFiles,
    scope.existing,
  );
  appendSetDifference(
    problems,
    "missing introduced floor",
    scope.added,
    introducedFloorFiles,
  );
  appendSetDifference(
    problems,
    "stale introduced floor",
    introducedFloorFiles,
    scope.added,
  );
  appendSetDifference(
    problems,
    "missing deleted-file policy",
    scope.deleted,
    deletedFiles,
  );
  appendSetDifference(
    problems,
    "stale deleted-file policy",
    deletedFiles,
    scope.deleted,
  );
  if (problems.length > 0) {
    throw new Error(
      `Coverage floor manifest does not match the production cleanup scope:\n${problems
        .map((problem) => `- ${problem}`)
        .join("\n")}`,
    );
  }
}

/**
 * @param {string[]} problems
 * @param {string} label
 * @param {string[]} expected
 * @param {string[]} actual
 */
function appendSetDifference(problems, label, expected, actual) {
  const actualSet = new Set(actual);
  for (const file of expected) {
    if (!actualSet.has(file)) problems.push(`${label}: ${file}`);
  }
}

/** @param {string} root @param {string} rawPath */
function toRepoRelativeCoveragePath(root, rawPath) {
  const absolutePath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(root, rawPath);
  const relativePath = normalizeRepoPath(relative(root, absolutePath));
  return relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith("../")
    ? null
    : relativePath;
}

/** @param {string} file */
function assertProductionCoveragePath(file) {
  if (!isProductionCoveragePath(file) || normalizeRepoPath(file) !== file) {
    throw new Error(`Invalid production coverage path: ${file}`);
  }
}

/** @param {string} file */
function isProductionCoveragePath(file) {
  if (!file || file.endsWith(".d.ts")) return false;
  if (
    file === "src/renderer/src/main.tsx" ||
    file === "src/renderer/src/pageExport/browserEntry.tsx"
  ) {
    return false;
  }
  return (
    (/^src\/main\/.+\.(?:ts|cjs)$/.test(file) && !file.endsWith(".d.ts")) ||
    /^src\/preload\/.+\.ts$/.test(file) ||
    /^src\/renderer\/src\/.+\.(?:ts|tsx)$/.test(file) ||
    /^src\/shared\/.+\.ts$/.test(file)
  );
}

/** @param {string} root @param {string} file */
function assertSourceFile(root, file) {
  const absolutePath = resolve(root, file);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Coverage floor source file is missing: ${file}`);
  }
}

/** @param {string} value */
function normalizeRepoPath(value) {
  return posix.normalize(String(value).replace(/\\/g, "/"));
}

/** @param {unknown} value @param {string[]} keys @param {string} label */
function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameStringArray(actual, expected)) {
    throw new Error(`${label} has missing or unknown fields.`);
  }
}

/** @param {string[]} left @param {string[]} right */
function sameStringArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** @param {string} filePath @param {string} label */
function readJsonFile(filePath, label) {
  let rawText;
  try {
    rawText = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${filePath}`, { cause: error });
  }
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath}`, {
      cause: error,
    });
  }
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function main() {
  try {
    const result = checkProductionCleanupCoverage();
    const floorStatus = result.comparedFloors
      ? `compared ${result.floorFiles} Windows baseline files`
      : `validated ${result.floorFiles} baseline records without cross-platform floor comparison`;
    console.log(
      `production cleanup coverage gate passed: ${floorStatus}; ${result.introducedFloorFiles} introduced files compared; ${result.deletedFiles} deletions recorded`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  CLEANUP_BASE_COMMIT,
  COVERAGE_METRICS,
  assertManifestCoversScope,
  checkProductionCleanupCoverage,
  collectCoverageScope,
  isProductionCoveragePath,
  loadCoverageManifest,
  loadCoverageSummary,
  parseCoverageStatusOutput,
  readCoveragePercent,
};

if (require.main === module) main();
