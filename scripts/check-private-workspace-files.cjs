const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { isForbiddenRepositoryPath } = require("./private-workspace-policy.cjs");

const rootArgumentIndex = process.argv.indexOf("--root");
const root =
  rootArgumentIndex >= 0 && process.argv[rootArgumentIndex + 1]
    ? resolve(process.argv[rootArgumentIndex + 1])
    : join(__dirname, "..");
const mode = process.argv.includes("--pre-push") ? "--pre-push" : "--index";
const violations =
  mode === "--pre-push" ? inspectPushedHistory() : inspectIndex();

if (violations.length > 0) {
  console.error(
    "Private workspace files were found in Git history; refusing to continue:",
  );
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `private workspace Git ${mode === "--pre-push" ? "push" : "index"} passed`,
);

/** @returns {string[]} */
function inspectIndex() {
  return parseNullSeparated(runGit(["ls-files", "-z", "--cached"]))
    .filter(isForbiddenRepositoryPath)
    .sort();
}

/** @returns {string[]} */
function inspectPushedHistory() {
  const updates = readFileSync(0, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  /** @type {Set<string>} */
  const inspectedCommits = new Set();
  /** @type {Set<string>} */
  const violations = new Set();
  for (const update of updates) {
    const [, localSha, , remoteSha] = update.split(/\s+/u);
    if (!localSha || isZeroObjectId(localSha)) continue;
    const revisionArgs = isZeroObjectId(remoteSha)
      ? ["rev-list", localSha, "--not", "--remotes"]
      : ["rev-list", `${remoteSha}..${localSha}`];
    for (const commit of runGit(revisionArgs).split(/\r?\n/u).filter(Boolean)) {
      if (inspectedCommits.has(commit)) continue;
      inspectedCommits.add(commit);
      for (const path of parseNullSeparated(
        runGit(["ls-tree", "-r", "--name-only", "-z", commit]),
      )) {
        if (isForbiddenRepositoryPath(path)) {
          violations.add(`${path} (${commit.slice(0, 12)})`);
        }
      }
    }
  }
  return [...violations].sort();
}

/** @param {string | undefined} value */
function isZeroObjectId(value) {
  return !value || /^0+$/u.test(value);
}

/** @param {string} value */
function parseNullSeparated(value) {
  return value.split("\0").filter(Boolean);
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    console.error(result.error || result.stderr || `git ${args[0]} failed`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}
