// @ts-check
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  writeFileSync,
} = require("node:fs");
const { join, relative, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const reports = join(root, ".tmp", "check-shards");
const results = join(root, ".tmp", "check-results");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const SHARD_COUNT = 4;

/** @typedef {{ index: number; count: number; commit: string; platform: string; arch: string; blobSha256: string; files: string[] }} ShardReceipt */

/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {string} path */
function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** @param {string} path */
function relativeFile(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function binding() {
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    platform: process.platform,
    arch: process.arch,
  };
}

/** @param {string[]} args @param {string | undefined} [shard] */
function runVitest(args, shard) {
  const env = { ...process.env };
  delete env.MGT_CHECK_SHARD;
  if (shard) env.MGT_CHECK_SHARD = shard;
  const result = spawnSync(process.execPath, [vitest, ...args], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Vitest failed (${result.status ?? result.signal})`);
}

/** @param {string} path @returns {string[]} */
function passedFiles(path) {
  const report = readJson(path);
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    (report.numRuntimeErrorTestSuites ?? 0) !== 0
  ) {
    throw new Error(`Test report did not pass: ${path}`);
  }
  if (!Array.isArray(report.testResults) || !report.testResults.length)
    throw new Error(`Empty test report: ${path}`);
  return report.testResults
    .map(
      /** @param {{ name: string }} file */ (file) => relativeFile(file.name),
    )
    .sort();
}

/** @param {string} shard */
function runShard(shard) {
  if (!/^[1-4]\/4$/u.test(shard))
    throw new Error("Expected shard 1/4 through 4/4");
  const index = Number(shard[0]);
  const blob = join(reports, "blobs", `${index}.json`);
  const receipt = join(reports, "receipts", `${index}.json`);
  const result = join(results, "vitest.json");
  mkdirSync(join(reports, "blobs"), { recursive: true });
  mkdirSync(join(reports, "receipts"), { recursive: true });
  mkdirSync(results, { recursive: true });
  for (const path of [blob, receipt, result])
    if (existsSync(path)) unlinkSync(path);
  runVitest(
    [
      "run",
      "--coverage",
      `--shard=${shard}`,
      "--reporter=default",
      "--reporter=json",
      "--reporter=blob",
      `--outputFile.json=${result}`,
      `--outputFile.blob=${blob}`,
    ],
    shard,
  );
  const files = passedFiles(result);
  writeFileSync(
    receipt,
    JSON.stringify({
      index,
      count: SHARD_COUNT,
      ...binding(),
      blobSha256: hashFile(blob),
      files,
    }),
  );
}

/**
 * @param {ShardReceipt[]} receipts
 * @param {string[]} expectedFiles
 * @param {{ commit: string; platform: string; arch: string }} expectedBinding
 */
function validateShardReceipts(receipts, expectedFiles, expectedBinding) {
  if (receipts.length !== SHARD_COUNT)
    throw new Error(`Expected ${SHARD_COUNT} shard receipts`);
  const indexes = new Set();
  const files = new Set();
  for (const receipt of receipts) {
    if (
      !Number.isInteger(receipt.index) ||
      receipt.index < 1 ||
      receipt.index > SHARD_COUNT ||
      receipt.count !== SHARD_COUNT ||
      indexes.has(receipt.index)
    ) {
      throw new Error("Missing, duplicate or invalid shard index");
    }
    indexes.add(receipt.index);
    if (
      receipt.commit !== expectedBinding.commit ||
      receipt.platform !== expectedBinding.platform ||
      receipt.arch !== expectedBinding.arch
    ) {
      throw new Error(
        "Shard commit/platform/architecture does not match this merge job",
      );
    }
    if (
      !/^[a-f0-9]{64}$/u.test(receipt.blobSha256) ||
      !Array.isArray(receipt.files) ||
      receipt.files.length === 0
    )
      throw new Error("Invalid shard receipt");
    for (const file of receipt.files) {
      if (files.has(file)) throw new Error(`Duplicate test file: ${file}`);
      files.add(file);
    }
  }
  const expected = new Set(expectedFiles);
  const missing = expectedFiles.filter((file) => !files.has(file));
  const extra = [...files].filter((file) => !expected.has(file));
  if (missing.length || extra.length)
    throw new Error(
      `Shard inventory mismatch: missing=${missing.join(", ")}; extra=${extra.join(", ")}`,
    );
  return files.size;
}

function mergeShards() {
  mkdirSync(results, { recursive: true });
  const expectedNames = Array.from(
    { length: SHARD_COUNT },
    (_, index) => `${index + 1}.json`,
  ).sort();
  for (const directory of ["receipts", "blobs"]) {
    if (
      JSON.stringify(readdirSync(join(reports, directory)).sort()) !==
      JSON.stringify(expectedNames)
    )
      throw new Error(`Expected exactly four ${directory} files`);
  }
  const inventoryPath = join(results, "test-inventory.json");
  runVitest(["list", "--filesOnly", `--json=${inventoryPath}`]);
  /** @type {string[]} */
  const inventory = readJson(inventoryPath).map(
    /** @param {{ file: string }} entry */ (entry) => relativeFile(entry.file),
  );
  /** @type {ShardReceipt[]} */
  const receipts = expectedNames.map((name) =>
    readJson(join(reports, "receipts", name)),
  );
  const count = validateShardReceipts(receipts, inventory, binding());
  for (const receipt of receipts) {
    if (
      hashFile(join(reports, "blobs", `${receipt.index}.json`)) !==
      receipt.blobSha256
    )
      throw new Error(`Shard ${receipt.index} blob checksum mismatch`);
  }
  const mergedPath = join(results, "vitest.json");
  if (existsSync(mergedPath)) unlinkSync(mergedPath);
  runVitest([
    "run",
    `--merge-reports=${join(reports, "blobs")}`,
    "--coverage",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${mergedPath}`,
  ]);
  const mergedFiles = passedFiles(mergedPath);
  if (JSON.stringify(mergedFiles) !== JSON.stringify([...inventory].sort()))
    throw new Error("Merged report does not contain the full test inventory");
  console.log(
    `[check] All ${count} test files accounted for exactly once across ${SHARD_COUNT} shards.`,
  );
}

module.exports = { validateShardReceipts };
if (require.main === module) {
  try {
    const [command, shard, ...extra] = process.argv.slice(2);
    if (command === "run" && shard && !extra.length) runShard(shard);
    else if (command === "merge" && shard === undefined) mergeShards();
    else throw new Error("Usage: check-test-shards.cjs run <1/4..4/4> | merge");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
