const { createHash } = require("node:crypto");
const {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");

const CACHE_SCHEMA_VERSION = 1;

/**
 * @typedef {{
 *   cacheFile: string;
 *   cacheKey: string;
 *   fingerprintSalt: string;
 *   getInputFiles: () => string[];
 *   getOutputFiles: () => string[];
 *   getRequiredOutputFiles: () => string[];
 *   root: string;
 * }} CachedBuildStep
 *
 * @typedef {{
 *   decision: "build" | "skip";
 *   inputFingerprint: string;
 *   reason: string;
 * }} CachedBuildPlan
 *
 * @typedef {{
 *   cacheKey: string;
 *   inputFingerprint: string;
 *   outputFingerprint: string;
 *   schemaVersion: number;
 * }} CacheRecord
 */

/**
 * Run a synchronous build only when its content plan is stale. The successful
 * record is written after the action and its outputs have both been verified.
 *
 * @param {CachedBuildStep} step
 * @param {() => void} build
 * @param {(plan: CachedBuildPlan) => void} [onPlan]
 * @returns {{ status: "built" | "skipped"; reason: string }}
 */
function runCachedBuildStep(step, build, onPlan) {
  const plan = planCachedBuildStep(step);
  onPlan?.(plan);
  if (plan.decision === "skip") {
    return { status: "skipped", reason: plan.reason };
  }

  build();
  writeSuccessfulCacheRecord(step, plan.inputFingerprint);
  return { status: "built", reason: plan.reason };
}

/**
 * @param {CachedBuildStep} step
 * @returns {CachedBuildPlan}
 */
function planCachedBuildStep(step) {
  const inputFingerprint = fingerprintFiles(
    step.root,
    step.getInputFiles(),
    step.fingerprintSalt,
  );
  const cached = readCacheRecord(step.cacheFile, step.cacheKey);
  if (cached.status !== "valid") {
    return {
      decision: "build",
      inputFingerprint,
      reason: cached.reason,
    };
  }
  if (cached.record.inputFingerprint !== inputFingerprint) {
    return {
      decision: "build",
      inputFingerprint,
      reason: "input content changed",
    };
  }

  const missingOutput = findMissingFile(step.getRequiredOutputFiles());
  if (missingOutput) {
    return {
      decision: "build",
      inputFingerprint,
      reason: `required output is missing: ${toRelativePath(step.root, missingOutput)}`,
    };
  }

  const outputFingerprint = fingerprintFiles(
    step.root,
    step.getOutputFiles(),
    step.fingerprintSalt,
  );
  if (cached.record.outputFingerprint !== outputFingerprint) {
    return {
      decision: "build",
      inputFingerprint,
      reason: "output content changed",
    };
  }
  return {
    decision: "skip",
    inputFingerprint,
    reason: "input and output content are unchanged",
  };
}

/**
 * @param {CachedBuildStep} step
 * @param {string} plannedInputFingerprint
 */
function writeSuccessfulCacheRecord(step, plannedInputFingerprint) {
  const currentInputFingerprint = fingerprintFiles(
    step.root,
    step.getInputFiles(),
    step.fingerprintSalt,
  );
  if (currentInputFingerprint !== plannedInputFingerprint) {
    throw new Error(
      `Cannot cache ${step.cacheKey}: input content changed during the build`,
    );
  }

  const missingOutput = findMissingFile(step.getRequiredOutputFiles());
  if (missingOutput) {
    throw new Error(
      `Cannot cache ${step.cacheKey}: required output is missing: ${toRelativePath(step.root, missingOutput)}`,
    );
  }

  /** @type {CacheRecord} */
  const record = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    cacheKey: step.cacheKey,
    inputFingerprint: currentInputFingerprint,
    outputFingerprint: fingerprintFiles(
      step.root,
      step.getOutputFiles(),
      step.fingerprintSalt,
    ),
  };
  writeCacheRecord(step.cacheFile, record);
}

/**
 * @param {string} root
 * @returns {CachedBuildStep}
 */
function createElectronCompileCacheStep(root) {
  const sourceRoot = join(root, "src");
  const mainSource = join(sourceRoot, "main");
  const sharedSource = join(sourceRoot, "shared");
  const preloadSource = join(sourceRoot, "preload");
  const pageExportSource = join(sourceRoot, "renderer", "src");
  const cacheFile = join(root, ".tmp", "dev-build-cache", "electron.json");

  const getTscInputs = () => [
    ...listTreeFiles(mainSource, isTscInputFile),
    ...listTreeFiles(sharedSource, isTscInputFile),
  ];
  const getBundledInputs = () => [
    ...listTreeFiles(preloadSource),
    ...listTreeFiles(pageExportSource, isBrowserSourceInputFile),
  ];

  return {
    root,
    cacheFile,
    cacheKey: "electron-compile",
    fingerprintSalt: platformFingerprintSalt(),
    getInputFiles: () => [
      join(root, "scripts", "compile-electron.cjs"),
      __filename,
      join(root, "tsconfig.json"),
      join(root, "tsconfig.electron.json"),
      join(root, "vite.preload.config.ts"),
      join(root, "vite.page-export.config.ts"),
      join(root, "package.json"),
      join(root, "package-lock.json"),
      ...getTscInputs(),
      ...getBundledInputs(),
    ],
    getOutputFiles: () => [
      ...listTreeFiles(join(root, "out", "main"), undefined, true),
      ...listTreeFiles(join(root, "out", "shared"), undefined, true),
      ...listTreeFiles(join(root, "out", "preload"), undefined, true),
      ...listTreeFiles(join(root, "out", "page-export"), undefined, true),
    ],
    getRequiredOutputFiles: () => [
      ...emittedTscOutputs(sourceRoot, getTscInputs()),
      join(root, "out", "preload", "index.js"),
      join(root, "out", "preload", "index.js.map"),
      join(root, "out", "page-export", "runtime.js"),
      join(root, "out", "page-export", "runtime.js.map"),
      join(root, "out", "page-export", "styles.css"),
    ],
  };
}

/**
 * @param {string} root
 * @param {string} outputDir
 * @returns {CachedBuildStep}
 */
function createRuntimeAssetsCacheStep(root, outputDir) {
  const sourceDir = join(root, "src", "main", "runtime");
  const sourceFiles = () => listTreeFiles(sourceDir);
  return {
    root,
    cacheFile: join(root, ".tmp", "dev-build-cache", "runtime-assets.json"),
    cacheKey: "runtime-assets",
    fingerprintSalt: platformFingerprintSalt(),
    getInputFiles: () => [
      join(root, "scripts", "prepare-runtime.cjs"),
      __filename,
      ...sourceFiles(),
    ],
    getOutputFiles: () => listTreeFiles(outputDir, undefined, true),
    getRequiredOutputFiles: () =>
      sourceFiles().map((sourcePath) =>
        join(outputDir, relative(sourceDir, sourcePath)),
      ),
  };
}

/**
 * @param {string} directory
 * @param {(filePath: string) => boolean} [include]
 * @param {boolean} [allowMissing]
 * @returns {string[]}
 */
function listTreeFiles(directory, include, allowMissing = false) {
  if (!existsSync(directory)) {
    if (allowMissing) return [];
    throw new Error(`Cached input directory is missing: ${directory}`);
  }
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Cached tree must be a real directory: ${directory}`);
  }

  /** @type {string[]} */
  const files = [];
  visitDirectory(directory, include, files);
  return files.sort(comparePaths);
}

/**
 * @param {string} directory
 * @param {((filePath: string) => boolean) | undefined} include
 * @param {string[]} files
 */
function visitDirectory(directory, include, files) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => comparePaths(left.name, right.name),
  );
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not supported in cached trees: ${entryPath}`,
      );
    }
    if (entry.isDirectory()) {
      visitDirectory(entryPath, include, files);
      continue;
    }
    if (entry.isFile() && (!include || include(entryPath))) {
      files.push(entryPath);
    }
  }
}

/**
 * @param {string} root
 * @param {string[]} filePaths
 * @param {string} salt
 */
function fingerprintFiles(root, filePaths, salt) {
  const resolvedFiles = [
    ...new Set(filePaths.map((filePath) => resolve(filePath))),
  ].sort((left, right) =>
    comparePaths(toRelativePath(root, left), toRelativePath(root, right)),
  );
  const hash = createHash("sha256");
  hash.update(`manga-dev-build-cache:${CACHE_SCHEMA_VERSION}\0${salt}\0`);
  for (const filePath of resolvedFiles) {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Cached content must be a real file: ${filePath}`);
    }
    const content = readFileSync(filePath);
    hash.update(toRelativePath(root, filePath));
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * @param {string} sourceRoot
 * @param {string[]} inputFiles
 */
function emittedTscOutputs(sourceRoot, inputFiles) {
  return inputFiles.flatMap((filePath) => {
    if (filePath.endsWith(".d.ts")) return [];
    if (filePath.endsWith(".json")) {
      return [join(dirname(sourceRoot), "out", relative(sourceRoot, filePath))];
    }
    if (filePath.endsWith(".ts")) {
      const outputBase = join(
        dirname(sourceRoot),
        "out",
        relative(sourceRoot, filePath).slice(0, -".ts".length),
      );
      return [`${outputBase}.js`, `${outputBase}.js.map`];
    }
    return [];
  });
}

/** @param {string} filePath */
function isTscInputFile(filePath) {
  return filePath.endsWith(".ts") || filePath.endsWith(".json");
}

/** @param {string} filePath */
function isBrowserSourceInputFile(filePath) {
  return /\.(?:css|json|ts|tsx)$/.test(filePath);
}

/** @param {string[]} filePaths */
function findMissingFile(filePaths) {
  return filePaths.find((filePath) => {
    if (!existsSync(filePath)) return true;
    const metadata = lstatSync(filePath);
    return !metadata.isFile() || metadata.isSymbolicLink();
  });
}

/**
 * @param {string} cacheFile
 * @param {string} cacheKey
 * @returns {{ status: "valid"; record: CacheRecord } | { status: "invalid"; reason: string }}
 */
function readCacheRecord(cacheFile, cacheKey) {
  if (!existsSync(cacheFile)) {
    return { status: "invalid", reason: "no successful cache record" };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "invalid",
      reason: `cache record is unreadable: ${message}`,
    };
  }
  if (!isCacheRecord(parsed) || parsed.cacheKey !== cacheKey) {
    return { status: "invalid", reason: "cache record format changed" };
  }
  return { status: "valid", record: parsed };
}

/** @param {unknown} value */
function isCacheRecord(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = /** @type {Partial<CacheRecord>} */ (value);
  return (
    record.schemaVersion === CACHE_SCHEMA_VERSION &&
    typeof record.cacheKey === "string" &&
    typeof record.inputFingerprint === "string" &&
    typeof record.outputFingerprint === "string"
  );
}

/**
 * @param {string} cacheFile
 * @param {CacheRecord} record
 */
function writeCacheRecord(cacheFile, record) {
  mkdirSync(dirname(cacheFile), { recursive: true });
  const temporaryFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temporaryFile, cacheFile);
}

/**
 * @param {string} root
 * @param {string} filePath
 */
function toRelativePath(root, filePath) {
  const relativePath = relative(resolve(root), resolve(filePath));
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Cached path must stay within the project root: ${filePath}`,
    );
  }
  return relativePath.replaceAll("\\", "/");
}

function platformFingerprintSalt() {
  return `${process.platform}/${process.arch}/node-${process.versions.node}`;
}

/** @param {string} left @param {string} right */
function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

module.exports = {
  createElectronCompileCacheStep,
  createRuntimeAssetsCacheStep,
  listTreeFiles,
  planCachedBuildStep,
  runCachedBuildStep,
};
