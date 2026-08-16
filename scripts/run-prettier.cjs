#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { lstatSync } = require("node:fs");
const { isAbsolute, join, relative, resolve } = require("node:path");

const prettier = require("prettier");

const repoRoot = resolve(__dirname, "..");
const prettierCli = resolve(
  repoRoot,
  "node_modules",
  "prettier",
  "bin",
  "prettier.cjs",
);

// These directories contain repository-owned source, tests, tooling, docs, and
// packaging inputs. A new top-level directory must be reviewed here instead of
// silently falling outside the formatting gate.
const AUTHORITATIVE_TOP_LEVEL_DIRECTORIES = new Set([
  ".github",
  "build",
  "docs",
  "scripts",
  "src",
  "tests",
  "third_party",
  "tools",
]);

// Claude's local settings are per-user/per-machine state, not a repository
// artifact. Explicitly exclude the file so the gate is stable even when two
// developers have different global Git ignore configurations.
const PERSONAL_LOCAL_FILES = new Set([".claude/settings.local.json"]);
const MAX_BATCH_ARGUMENT_CHARACTERS = 24_000;

/** @param {string} value */
function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** @param {string} path */
function isPersonalLocalFile(path) {
  return PERSONAL_LOCAL_FILES.has(normalizeRepoPath(path));
}

/**
 * @param {string[]} args
 * @returns {"check" | "write"}
 */
function parseCliMode(args) {
  if (args.length === 1 && args[0] === "--check") return "check";
  if (args.length === 1 && args[0] === "--write") return "write";
  throw new Error("Usage: node scripts/run-prettier.cjs --check|--write");
}

/** @param {string} root */
function listGitWorktreeFiles(root) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "buffer",
      shell: false,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Could not enumerate Git worktree files (exit ${result.status ?? 1}).`,
    );
  }
  return Buffer.from(result.stdout ?? [])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepoPath);
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function assertAuthoritativePaths(paths) {
  const unknownDirectories = new Set();
  for (const path of paths) {
    const separatorIndex = path.indexOf("/");
    if (separatorIndex < 0) continue;
    const topLevelDirectory = path.slice(0, separatorIndex);
    if (!AUTHORITATIVE_TOP_LEVEL_DIRECTORIES.has(topLevelDirectory)) {
      unknownDirectories.add(topLevelDirectory);
    }
  }
  if (unknownDirectories.size > 0) {
    throw new Error(
      [
        "Prettier-eligible files exist in unreviewed top-level directories:",
        ...[...unknownDirectories].sort().map((path) => `- ${path}`),
        "Review ownership and add the directory to run-prettier.cjs explicitly.",
      ].join("\n"),
    );
  }
  return paths;
}

/**
 * @param {{
 *   root?: string;
 *   listFiles?: (root: string) => string[];
 *   getFileInfo?: typeof prettier.getFileInfo;
 *   lstat?: typeof lstatSync;
 * }} [options]
 */
async function collectPrettierInventory(options = {}) {
  const root = options.root ?? repoRoot;
  const listFiles = options.listFiles ?? listGitWorktreeFiles;
  const getFileInfo = options.getFileInfo ?? prettier.getFileInfo;
  const lstat = options.lstat ?? lstatSync;
  const candidates = listFiles(root)
    .map(normalizeRepoPath)
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .filter((path) => !isPersonalLocalFile(path))
    .filter((path) => assertRealWorktreeFile(root, path, lstat));
  const inspected = await Promise.all(
    candidates.map(async (path) => ({
      path,
      info: await getFileInfo(resolve(root, path), {
        ignorePath: resolve(root, ".prettierignore"),
        withNodeModules: false,
      }),
    })),
  );
  const eligiblePaths = inspected
    .filter(({ info }) => !info.ignored && Boolean(info.inferredParser))
    .map(({ path }) => path)
    .sort();
  return assertAuthoritativePaths(eligiblePaths);
}

/**
 * `resolve(root, path)` is only a lexical boundary. Reject symlinks and Windows
 * junctions in every repository-relative path component so `format --write`
 * cannot be redirected to files outside the worktree.
 *
 * @param {string} root
 * @param {string} path
 * @param {typeof lstatSync} [lstat]
 */
function assertRealWorktreeFile(root, path, lstat = lstatSync) {
  const normalized = normalizeRepoPath(path);
  const repositoryRoot = resolve(root);
  const candidate = resolve(repositoryRoot, normalized);
  const child = relative(repositoryRoot, candidate);
  if (
    !child ||
    /^\.\.(?:[\\/]|$)/u.test(child) ||
    isAbsolute(child) ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `Prettier inventory path escapes the worktree: ${normalized}`,
    );
  }
  let cursor = repositoryRoot;
  let metadata;
  for (const part of child.split(/[\\/]/u)) {
    cursor = join(cursor, part);
    try {
      metadata = lstat(cursor);
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return false;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Prettier inventory refuses symbolic links: ${normalized}`,
      );
    }
  }
  return Boolean(metadata?.isFile());
}

/** @param {unknown} error */
function readErrorCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * @param {string[]} paths
 * @param {number} [maximumCharacters]
 */
function buildPathBatches(
  paths,
  maximumCharacters = MAX_BATCH_ARGUMENT_CHARACTERS,
) {
  /** @type {string[][]} */
  const batches = [];
  /** @type {string[]} */
  let batch = [];
  let characters = 0;
  for (const path of paths) {
    const nextCharacters = path.length + 3;
    if (batch.length > 0 && characters + nextCharacters > maximumCharacters) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(path);
    characters += nextCharacters;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * @param {"check" | "write"} mode
 * @param {string[]} paths
 * @param {{ root?: string; spawn?: typeof spawnSync }} [options]
 */
function runPrettier(mode, paths, options = {}) {
  const root = options.root ?? repoRoot;
  const spawn = options.spawn ?? spawnSync;
  const ignorePath = resolve(root, ".prettierignore");
  let failed = false;
  for (const batch of buildPathBatches(paths)) {
    const result = spawn(
      process.execPath,
      [
        prettierCli,
        `--${mode}`,
        // A persistent Prettier cache can outlive configuration or dependency
        // changes and make a local checkout skip files that fresh CI rejects.
        // Formatting is intentionally uncached so both environments inspect
        // the exact current bytes with the exact current toolchain.
        "--ignore-path",
        ignorePath,
        "--",
        ...batch,
      ],
      {
        cwd: root,
        shell: false,
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

async function main() {
  const mode = parseCliMode(process.argv.slice(2));
  const paths = await collectPrettierInventory();
  console.log(`Prettier ${mode} inventory: ${paths.length} files.`);
  process.exitCode = runPrettier(mode, paths);
}

module.exports = {
  AUTHORITATIVE_TOP_LEVEL_DIRECTORIES,
  PERSONAL_LOCAL_FILES,
  assertRealWorktreeFile,
  assertAuthoritativePaths,
  buildPathBatches,
  collectPrettierInventory,
  isPersonalLocalFile,
  listGitWorktreeFiles,
  normalizeRepoPath,
  parseCliMode,
  runPrettier,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
