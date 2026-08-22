const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { isAbsolute, join, relative, resolve } = require("node:path");
const {
  resolveDefaultFontMatchingRuntimeBundleDir,
} = require("./prepare-runtime.cjs");

const CACHE_SCHEMA_VERSION = 2;
const CACHE_DIRECTORY = join(".tmp", "check-build-cache");
const OUTPUT_DIRECTORIES = [
  "main",
  "shared",
  "preload",
  "page-export",
  "renderer",
  "app-runtime",
];
const REQUIRED_OUTPUTS = [
  join("out", "main", "bootstrap.js"),
  join("out", "main", "runtime", "python-pip-environment.cjs"),
  join("out", "preload", "index.js"),
  join("out", "page-export", "runtime.js"),
  join("out", "page-export", "styles.css"),
  join("out", "renderer", "index.html"),
  join("out", "app-runtime", "openai-oauth-runtime.mjs"),
];

/**
 * @typedef {{ path: string; bytes: number; sha256: string }} CachedFile
 * @typedef {{
 *   schemaVersion: number;
 *   inputFingerprint: string;
 *   platform: string;
 *   outputs: CachedFile[];
 * }} CacheManifest
 */

/** @param {string} root */
function createCheckBuildPlan(root) {
  const inputs = collectBuildInputs(root);
  const inputFingerprint = fingerprintFiles(
    root,
    inputs,
    buildEnvironmentFingerprint(process.env),
  );
  return {
    root: resolve(root),
    inputs,
    inputFingerprint,
    cacheRoot: join(root, CACHE_DIRECTORY),
    entryDirectory: join(root, CACHE_DIRECTORY, "entries", inputFingerprint),
  };
}

/** @param {ReturnType<typeof createCheckBuildPlan>} plan */
function restoreCheckBuild(plan) {
  const inspected = inspectCacheEntry(plan);
  if (!inspected.valid) return { restored: false, reason: inspected.reason };
  for (const outputName of OUTPUT_DIRECTORIES) {
    const destination = join(plan.root, "out", outputName);
    emptyOwnedDirectory(join(plan.root, "out"), destination, plan.root);
  }
  for (const file of inspected.manifest.outputs) {
    const source = join(plan.entryDirectory, "snapshot", file.path);
    const destination = join(plan.root, file.path);
    mkdirSync(join(destination, ".."), { recursive: true });
    copyFileSync(source, destination);
  }
  const restored = collectOutputManifest(plan.root);
  if (!sameFiles(restored, inspected.manifest.outputs)) {
    throw new Error("Restored check build does not match its cache manifest.");
  }
  return {
    restored: true,
    reason: `restored content-addressed build ${plan.inputFingerprint.slice(0, 12)}`,
  };
}

/** @param {ReturnType<typeof createCheckBuildPlan>} plan */
function promoteCheckBuild(plan) {
  assertRealOwnedPath(plan.root, plan.cacheRoot);
  assertRealOwnedPath(plan.root, join(plan.entryDirectory, ".."));
  const currentFingerprint = createCheckBuildPlan(plan.root).inputFingerprint;
  if (currentFingerprint !== plan.inputFingerprint) {
    throw new Error(
      "Cannot promote check build: build inputs changed during check.",
    );
  }
  const outputs = collectOutputManifest(plan.root);
  assertRequiredOutputs(plan.root, outputs);

  const currentEntry = inspectCacheEntry(plan);
  if (currentEntry.valid && sameFiles(currentEntry.manifest.outputs, outputs)) {
    return { promoted: false, reason: "matching cache entry already exists" };
  }

  const staging = join(
    plan.cacheRoot,
    `promote-${plan.inputFingerprint}-${process.pid}-${Date.now()}`,
  );
  mkdirSync(staging, { recursive: true });
  const previousEntry = `${plan.entryDirectory}.stale-${process.pid}-${Date.now()}`;
  let movedPreviousEntry = false;
  try {
    for (const file of outputs) {
      const destination = join(staging, "snapshot", file.path);
      mkdirSync(join(destination, ".."), { recursive: true });
      copyFileSync(join(plan.root, file.path), destination);
    }
    /** @type {CacheManifest} */
    const manifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      inputFingerprint: plan.inputFingerprint,
      platform: platformSalt(),
      outputs,
    };
    writeFileSync(
      join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    if (existsSync(plan.entryDirectory)) {
      renameSync(plan.entryDirectory, previousEntry);
      movedPreviousEntry = true;
    }
    mkdirSync(join(plan.entryDirectory, ".."), { recursive: true });
    renameSync(staging, plan.entryDirectory);
    if (movedPreviousEntry && existsSync(previousEntry)) {
      try {
        emptyOwnedDirectory(plan.cacheRoot, previousEntry, plan.root);
        rmdirSync(previousEntry);
      } catch (error) {
        console.warn(
          `[check-cache] could not prune stale cache entry: ${String(error)}`,
        );
      }
    }
    pruneOldCacheEntries(plan);
    return { promoted: true, reason: "promoted verified build outputs" };
  } finally {
    if (existsSync(staging)) {
      emptyOwnedDirectory(plan.cacheRoot, staging, plan.root);
      rmdirSync(staging);
    }
    if (
      movedPreviousEntry &&
      !existsSync(plan.entryDirectory) &&
      existsSync(previousEntry)
    ) {
      renameSync(previousEntry, plan.entryDirectory);
    }
  }
}

/**
 * A snapshot is roughly the size of the packaged runtime. Keep only the newest
 * successful content-addressed entry so ordinary source edits cannot grow
 * `.tmp` by hundreds of megabytes indefinitely.
 *
 * @param {ReturnType<typeof createCheckBuildPlan>} plan
 */
function pruneOldCacheEntries(plan) {
  const entriesRoot = join(plan.cacheRoot, "entries");
  if (!existsSync(entriesRoot)) return;
  assertRealOwnedPath(plan.root, entriesRoot);
  const directoryEntries = readdirSync(entriesRoot, { withFileTypes: true });
  const unsafeEntry = directoryEntries.find((entry) => entry.isSymbolicLink());
  if (unsafeEntry) {
    throw new Error(
      `Check build cache refuses symbolic links: ${join(entriesRoot, unsafeEntry.name)}`,
    );
  }
  const entries = directoryEntries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({ path: join(entriesRoot, entry.name) }));
  const keep = resolve(plan.entryDirectory);
  for (const entry of entries) {
    if (keep === resolve(entry.path)) continue;
    emptyOwnedDirectory(entriesRoot, entry.path, plan.root);
    rmdirSync(entry.path);
  }
}

/** @param {ReturnType<typeof createCheckBuildPlan>} plan */
function inspectCacheEntry(plan) {
  const manifestPath = join(plan.entryDirectory, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { valid: false, reason: "no content-addressed build entry" };
  }
  try {
    assertRealOwnedPath(plan.root, plan.entryDirectory);
  } catch (error) {
    void error;
    return { valid: false, reason: "cache entry crosses a symbolic link" };
  }
  const manifestMetadata = lstatSync(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    return { valid: false, reason: "cache manifest is not a real file" };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    void error;
    return { valid: false, reason: "cache manifest is unreadable" };
  }
  if (!isCacheManifest(manifest, plan.inputFingerprint)) {
    return { valid: false, reason: "cache manifest is incompatible" };
  }
  let actual;
  try {
    actual = collectFiles(join(plan.entryDirectory, "snapshot"), {
      relativeTo: join(plan.entryDirectory, "snapshot"),
      prefix: "",
    });
  } catch (error) {
    void error;
    return { valid: false, reason: "cache snapshot is unreadable" };
  }
  if (!sameFiles(manifest.outputs, actual)) {
    return { valid: false, reason: "cache snapshot content is corrupt" };
  }
  return { valid: true, manifest };
}

/** @param {string} root */
function collectBuildInputs(root) {
  const files = [
    ...listGitWorktreeFiles(root),
    join("node_modules", "typescript", "package.json"),
    join("node_modules", "vite", "package.json"),
    join("node_modules", "@vitejs", "plugin-react", "package.json"),
    join("node_modules", "electron", "package.json"),
    join("node_modules", "rolldown", "package.json"),
    join("node_modules", "openai-oauth", "package.json"),
    join("node_modules", "react", "package.json"),
    join("node_modules", "react-dom", "package.json"),
  ].map((path) => (isAbsolute(path) ? path : join(root, path)));
  for (const envFile of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    const filePath = join(root, envFile);
    if (existsSync(filePath)) files.push(filePath);
  }
  const runtimeBundle = resolveDefaultFontMatchingRuntimeBundleDir(root);
  if (existsSync(runtimeBundle)) {
    files.push(...collectSourceFiles(root, runtimeBundle));
  }
  return [...new Set(files.map((filePath) => resolve(filePath)))].sort(
    comparePaths,
  );
}

/** @param {string} root */
function listGitWorktreeFiles(root) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "buffer", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Cannot enumerate check build inputs (git exit ${result.status ?? 1}).`,
    );
  }
  const paths = Buffer.from(result.stdout ?? [])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => join(root, path));
  return paths.filter((path) => isRealBuildInputFile(path));
}

/**
 * @param {string} path
 * @param {{ lstat?: typeof lstatSync }} [options]
 */
function isRealBuildInputFile(path, options = {}) {
  const lstat = options.lstat ?? lstatSync;
  let metadata;
  try {
    metadata = lstat(path);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Build cache inputs cannot be symbolic links: ${path}`);
  }
  return metadata.isFile();
}

/**
 * @param {string} root
 * @param {string} directory
 * @param {{ excludedDirectories?: string[] }} [options]
 */
function collectSourceFiles(root, directory, options = {}) {
  if (!existsSync(directory)) return [];
  const excluded = (options.excludedDirectories ?? []).map((filePath) =>
    resolve(filePath),
  );
  return collectTreeFiles(directory, (path) =>
    excluded.some((parent) => isSameOrDescendant(parent, path)),
  );
}

/** @param {string} root */
function collectOutputManifest(root) {
  assertRealOwnedPath(root, join(root, "out"));
  return OUTPUT_DIRECTORIES.flatMap((outputName) =>
    collectFiles(join(root, "out", outputName), {
      relativeTo: root,
      prefix: join("out", outputName),
    }),
  ).sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * @param {string} directory
 * @param {{ relativeTo: string; prefix: string }} options
 */
function collectFiles(directory, options) {
  if (!existsSync(directory)) return [];
  const files = collectTreeFiles(directory);
  // Sort after normalizing relative paths. Sorting Windows absolute paths first
  // gives `libraryStore` before `library\...` because `\\` and `/` have
  // different code points, while manifests are ordered by portable `/` paths.
  return files
    .map((filePath) => {
      const metadata = lstatSync(filePath);
      return {
        path: normalizePath(
          options.prefix
            ? join(options.prefix, relative(directory, filePath))
            : relative(options.relativeTo, filePath),
        ),
        bytes: metadata.size,
        sha256: sha256File(filePath),
      };
    })
    .sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * @param {string} directory
 * @param {(path: string) => boolean} [skipDirectory]
 */
function collectTreeFiles(directory, skipDirectory) {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Cached tree must be a real directory: ${directory}`);
  }
  /** @type {string[]} */
  const files = [];
  visitTree(directory, files, skipDirectory);
  return files.sort(comparePaths);
}

/** @param {string} directory @param {string[]} files @param {(path: string) => boolean} [skipDirectory] */
function visitTree(directory, files, skipDirectory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => comparePaths(left.name, right.name),
  )) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not supported in cached trees: ${entryPath}`,
      );
    }
    if (entry.isDirectory()) {
      if (!skipDirectory?.(entryPath))
        visitTree(entryPath, files, skipDirectory);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
}

/** @param {string} root @param {string[]} files @param {string} environmentFingerprint */
function fingerprintFiles(root, files, environmentFingerprint) {
  const hash = createHash("sha256");
  hash.update(
    `manga-check-build-cache:${CACHE_SCHEMA_VERSION}\0${platformSalt()}\0${environmentFingerprint}\0`,
  );
  for (const filePath of files) {
    assertRealOwnedPath(root, filePath);
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Build cache input must be a real file: ${filePath}`);
    }
    const relativePath = safeRelative(root, filePath);
    const content = readFileSync(filePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env */
function buildEnvironmentFingerprint(env) {
  const selected = Object.entries(env)
    .filter(
      ([key]) =>
        key === "NODE_ENV" ||
        key === "BROWSERSLIST_ENV" ||
        key.startsWith("VITE_") ||
        key.startsWith("MGT_") ||
        key.startsWith("MANGA_TRANSLATOR_"),
    )
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  return createHash("sha256").update(JSON.stringify(selected)).digest("hex");
}

/**
 * @param {string} cacheRoot
 * @param {string} directory
 * @param {string} repositoryRoot
 */
function emptyOwnedDirectory(cacheRoot, directory, repositoryRoot) {
  const resolvedDirectory = resolve(directory);
  const resolvedRoot = resolve(cacheRoot);
  if (!isSameOrDescendant(resolvedRoot, resolvedDirectory)) {
    throw new Error(`Refusing to clean unexpected cached path: ${directory}`);
  }
  assertRealOwnedPath(repositoryRoot, resolvedRoot);
  assertRealOwnedPath(repositoryRoot, resolvedDirectory);
  if (!existsSync(directory)) return;
  const metadata = lstatSync(resolvedDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Cached output must be a real directory: ${directory}`);
  }
  for (const entry of readdirSync(resolvedDirectory)) {
    removePath(join(resolvedDirectory, entry));
  }
}

/**
 * Reject a symlink or Windows junction in any repository-relative ancestor.
 * A lexical `resolve()` containment check alone would allow `out` or `.tmp`
 * to redirect cache writes and recursive cleanup outside the worktree.
 *
 * @param {string} repositoryRoot
 * @param {string} candidate
 * @param {{ exists?: typeof existsSync; lstat?: typeof lstatSync }} [options]
 */
function assertRealOwnedPath(repositoryRoot, candidate, options = {}) {
  const exists = options.exists ?? existsSync;
  const lstat = options.lstat ?? lstatSync;
  const root = resolve(repositoryRoot);
  const target = resolve(candidate);
  if (!isSameOrDescendant(root, target)) {
    throw new Error(
      `Cached path must stay inside the repository: ${candidate}`,
    );
  }
  const child = relative(root, target);
  if (child === "") return;
  let cursor = root;
  for (const part of child.split(/[\\/]/u)) {
    cursor = join(cursor, part);
    if (!exists(cursor)) return;
    if (lstat(cursor).isSymbolicLink()) {
      throw new Error(`Check build cache refuses symbolic links: ${cursor}`);
    }
  }
}

/** @param {string} target */
function removePath(target) {
  const metadata = lstatSync(target);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    for (const entry of readdirSync(target)) removePath(join(target, entry));
    rmdirSync(target);
  } else {
    unlinkSync(target);
  }
}

/** @param {string} root @param {CachedFile[]} outputs */
function assertRequiredOutputs(root, outputs) {
  const outputPaths = new Set(outputs.map((file) => file.path));
  const missing = REQUIRED_OUTPUTS.find(
    (path) =>
      !outputPaths.has(normalizePath(path)) || !existsSync(join(root, path)),
  );
  if (missing)
    throw new Error(
      `Cannot cache build: required output is missing: ${missing}`,
    );
}

/** @param {unknown} value @param {string} fingerprint */
function isCacheManifest(value, fingerprint) {
  if (typeof value !== "object" || value === null) return false;
  const manifest = /** @type {Partial<CacheManifest>} */ (value);
  const outputs = manifest.outputs;
  return (
    manifest.schemaVersion === CACHE_SCHEMA_VERSION &&
    manifest.inputFingerprint === fingerprint &&
    manifest.platform === platformSalt() &&
    Array.isArray(outputs) &&
    outputs.length > 0 &&
    outputs.every(
      (file) =>
        typeof file.path === "string" &&
        isSafeCachedOutputPath(file.path) &&
        typeof file.bytes === "number" &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        /^[a-f0-9]{64}$/u.test(file.sha256),
    ) &&
    sameOrder(
      outputs.map((file) => file.path),
      outputs.map((file) => file.path).sort(comparePaths),
    ) &&
    new Set(outputs.map((file) => file.path)).size === outputs.length &&
    REQUIRED_OUTPUTS.every((path) =>
      outputs.some((file) => file.path === normalizePath(path)),
    )
  );
}

/** @param {string} path */
function isSafeCachedOutputPath(path) {
  const parts = path.split("/");
  return (
    normalizePath(path) === path &&
    /^out\/(?:main|shared|preload|page-export|renderer|app-runtime)\//u.test(
      path,
    ) &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** @param {string[]} left @param {string[]} right */
function sameOrder(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** @param {CachedFile[]} left @param {CachedFile[]} right */
function sameFiles(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** @param {string} path */
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** @param {string} root @param {string} path */
function safeRelative(root, path) {
  const candidate = relative(resolve(root), resolve(path));
  if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) {
    throw new Error(`Cache input must stay inside the repository: ${path}`);
  }
  return normalizePath(candidate);
}

function platformSalt() {
  return `${process.platform}/${process.arch}/node-${process.versions.node}`;
}

/** @param {string} parent @param {string} candidate */
function isSameOrDescendant(parent, candidate) {
  const child = relative(resolve(parent), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** @param {string} value */
function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

/** @param {unknown} error */
function readErrorCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/** @param {string} left @param {string} right */
function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

module.exports = {
  OUTPUT_DIRECTORIES,
  REQUIRED_OUTPUTS,
  assertRealOwnedPath,
  buildEnvironmentFingerprint,
  collectOutputManifest,
  createCheckBuildPlan,
  inspectCacheEntry,
  isRealBuildInputFile,
  promoteCheckBuild,
  restoreCheckBuild,
};
