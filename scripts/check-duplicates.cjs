const { spawnSync } = require("node:child_process");
const { mkdirSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const outputDirectory = join(projectRoot, ".tmp", "check-jscpd");
const reportPath = join(outputDirectory, "jscpd-report.json");
const baselinePath = join(__dirname, "jscpd-baseline.json");
const cliPath = require.resolve("jscpd/run-jscpd.js");

/**
 * @typedef {{ name?: string; start?: number }} CloneFile
 * @typedef {{ firstFile?: CloneFile; secondFile?: CloneFile; lines?: number; tokens?: number; isNew?: boolean }} Clone
 * @typedef {{ duplicates?: Clone[] }} DuplicateReport
 * @typedef {{ fingerprints?: Record<string, number> }} DuplicateBaseline
 */

/** @param {unknown} value */
function asErrorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {Clone} clone */
function formatClone(clone) {
  const first = clone.firstFile ?? {};
  const second = clone.secondFile ?? {};
  return `${first.name ?? "unknown"}:${first.start ?? "?"} <-> ${second.name ?? "unknown"}:${second.start ?? "?"} (${clone.lines ?? "?"} lines, ${clone.tokens ?? "?"} tokens)`;
}

function runDuplicateCheck() {
  mkdirSync(outputDirectory, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "src",
      "--config",
      ".jscpd.json",
      "--baseline",
      "scripts/jscpd-baseline.json",
      "--fail-on-new-clones",
      "0",
      "--no-colors",
      "--no-tips",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      shell: false,
    },
  );

  let report;
  try {
    report = /** @type {DuplicateReport} */ (readJson(reportPath));
  } catch (error) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.stderr.write(
      `Duplicate check did not produce a readable report: ${asErrorMessage(error)}\n`,
    );
    return false;
  }

  const clones = report.duplicates ?? [];
  const newClones = clones.filter((clone) => clone.isNew);
  const baseline = /** @type {DuplicateBaseline} */ (readJson(baselinePath));
  const baselineCount = Object.values(baseline.fingerprints ?? {}).reduce(
    (total, count) => total + Number(count),
    0,
  );
  const knownCloneCount = clones.length - newClones.length;
  const violations = [];

  for (const clone of newClones) {
    violations.push(`new clone: ${formatClone(clone)}`);
  }
  if (knownCloneCount < baselineCount) {
    violations.push(
      `clone baseline is stale (${baselineCount - knownCloneCount} known clone(s) were removed); update scripts/jscpd-baseline.json in the same refactor`,
    );
  }
  if (result.status !== 0 && newClones.length === 0) {
    violations.push(
      `jscpd exited with code ${result.status ?? "unknown"}: ${(result.stderr || result.stdout || "unknown failure").trim()}`,
    );
  }

  if (violations.length > 0) {
    process.stderr.write(
      `Duplicate clone ratchet failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`,
    );
    return false;
  }

  process.stdout.write(
    `Duplicate clone ratchet passed (${knownCloneCount} known, 0 new; 12 lines / 80 tokens).\n`,
  );
  return true;
}

module.exports = { formatClone, runDuplicateCheck };

if (require.main === module && !runDuplicateCheck()) {
  process.exitCode = 1;
}
