#!/usr/bin/env node
// @ts-check

const { createHash, randomUUID } = require("node:crypto");
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const AdmZip = require("adm-zip");
const yazl = require("yazl");

const root = join(__dirname, "..");
const defaultReleaseTag = "flux-runners-cpu-win-x64-r1";
const archiveFileName = "mgt-flux-klein-cpu-win-x64.zip";
const executableFileName = "mgt-flux-klein-cpu.exe";
const checksumFileName = "SHA256SUMS.txt";
const sourceExecutable = join(
  root,
  "tools",
  "mgt-flux-klein-cpu",
  executableFileName,
);
const args = parseArgs(process.argv.slice(2));
const releaseTag = args.releaseTag || defaultReleaseTag;
const manifestFileName = `${releaseTag}-manifest.json`;

if (!/^[a-z0-9][a-z0-9._-]+$/u.test(releaseTag)) {
  throw new Error(`Invalid release tag: ${releaseTag}`);
}

void main();

async function main() {
  if (args.verifyDir) {
    const result = verifyReleaseDirectory(resolve(args.verifyDir));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Flux CPU release packaging supports Windows x64 only.");
  }
  const outputDir = resolve(
    args.outputDir || join(root, ".tmp", releaseTag, "staging"),
  );
  if (existsSync(outputDir)) {
    throw new Error(
      `Release staging directory must not already exist: ${outputDir}`,
    );
  }
  if (!isUsableExecutable(sourceExecutable)) {
    throw new Error(
      `Missing CPU runner: ${sourceExecutable}. Run npm run build:flux-cpu-runner first.`,
    );
  }
  assertCpuOnlyRunner(sourceExecutable);
  mkdirSync(dirname(outputDir), { recursive: true });
  mkdirSync(outputDir);

  const archivePath = join(outputDir, archiveFileName);
  await writeDeterministicZip(sourceExecutable, archivePath);
  const executableBytes = statSync(sourceExecutable).size;
  const executableSha256 = sha256File(sourceExecutable);
  const archiveBytes = statSync(archivePath).size;
  const archiveSha256 = sha256File(archivePath);
  const sourceCommit = args.sourceCommit || readGitHead();
  const manifest = {
    schemaVersion: 1,
    releaseTag,
    sourceCommit,
    target: "x86_64-pc-windows-msvc",
    archiveContract: {
      format: "zip",
      entries: [executableFileName],
    },
    producer: {
      script: "scripts/package-flux-klein-cpu-release.cjs",
      buildScript: "scripts/prepare-flux-klein-cpu-runner.cjs",
      cargoArgs: ["build", "--release", "--locked", "--no-default-features"],
      capabilities: {
        backend: "cpu-native",
        cpuOnly: true,
        cudaCompiled: false,
        metalCompiled: false,
        protocolVersion: 1,
      },
    },
    assets: [
      {
        fileName: archiveFileName,
        bytes: archiveBytes,
        sha256: archiveSha256,
        executableFileName,
        executableBytes,
        executableSha256,
      },
    ],
  };
  const manifestPath = join(outputDir, manifestFileName);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    join(outputDir, checksumFileName),
    [
      `${archiveSha256}  ${archiveFileName}`,
      `${sha256File(manifestPath)}  ${manifestFileName}`,
      "",
    ].join("\n"),
    "ascii",
  );

  const result = verifyReleaseDirectory(outputDir);
  console.log(JSON.stringify(result, null, 2));
}

/** @param {string} sourcePath @param {string} archivePath */
async function writeDeterministicZip(sourcePath, archivePath) {
  const zip = new yazl.ZipFile();
  zip.addFile(sourcePath, executableFileName, {
    compress: true,
    mode: 0o100755,
    mtime: new Date("1980-01-01T00:00:00.000Z"),
  });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archivePath));
}

/** @param {string} directory */
function verifyReleaseDirectory(directory) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Flux CPU release verification requires Windows x64.");
  }
  const expectedFiles = [
    archiveFileName,
    checksumFileName,
    manifestFileName,
  ].sort();
  const actualFiles = readdirSync(directory).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Unexpected release inventory: ${actualFiles.join(", ") || "empty"}`,
    );
  }
  const manifestPath = join(directory, manifestFileName);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const asset = manifest?.assets?.[0];
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.releaseTag !== releaseTag ||
    manifest?.target !== "x86_64-pc-windows-msvc" ||
    manifest?.archiveContract?.format !== "zip" ||
    JSON.stringify(manifest?.archiveContract?.entries) !==
      JSON.stringify([executableFileName]) ||
    manifest?.assets?.length !== 1 ||
    asset?.fileName !== archiveFileName
  ) {
    throw new Error(
      "Flux CPU release manifest does not match the pinned contract.",
    );
  }
  const archivePath = join(directory, archiveFileName);
  assertPositiveInteger(asset.bytes, "archive bytes");
  assertSha256(asset.sha256, "archive SHA-256");
  assertPositiveInteger(asset.executableBytes, "executable bytes");
  assertSha256(asset.executableSha256, "executable SHA-256");
  if (statSync(archivePath).size !== asset.bytes) {
    throw new Error("Flux CPU archive byte size does not match the manifest.");
  }
  if (sha256File(archivePath) !== asset.sha256) {
    throw new Error("Flux CPU archive SHA-256 does not match the manifest.");
  }
  const expectedChecksums = [
    `${asset.sha256}  ${archiveFileName}`,
    `${sha256File(manifestPath)}  ${manifestFileName}`,
    "",
  ].join("\n");
  const actualChecksums = readFileSync(
    join(directory, checksumFileName),
    "ascii",
  );
  if (actualChecksums !== expectedChecksums) {
    throw new Error("SHA256SUMS.txt does not bind the archive and manifest.");
  }

  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  if (
    entries.length !== 1 ||
    entries[0].isDirectory ||
    entries[0].entryName !== executableFileName
  ) {
    throw new Error(
      `Unexpected Flux CPU ZIP inventory: ${entries.map((entry) => entry.entryName).join(", ")}`,
    );
  }
  const executable = entries[0].getData();
  if (
    executable.length !== asset.executableBytes ||
    sha256Buffer(executable) !== asset.executableSha256
  ) {
    throw new Error("The archived executable does not match the manifest.");
  }
  const probePath = join(
    tmpdir(),
    `mgt-flux-klein-cpu-release-probe-${randomUUID()}.exe`,
  );
  try {
    writeFileSync(probePath, executable);
    assertCpuOnlyRunner(probePath);
  } finally {
    rmSync(probePath, { force: true });
  }
  return {
    ok: true,
    releaseTag,
    files: actualFiles,
    archiveBytes: asset.bytes,
    archiveSha256: asset.sha256,
    executableBytes: asset.executableBytes,
    executableSha256: asset.executableSha256,
  };
}

/** @param {string} path */
function assertCpuOnlyRunner(path) {
  const capabilities = runJsonProbe(path, ["--capabilities"]);
  if (
    capabilities?.backend !== "cpu-native" ||
    capabilities?.cpu_only !== true ||
    capabilities?.cuda_compiled !== false ||
    capabilities?.metal_compiled !== false ||
    capabilities?.protocol_version !== 1
  ) {
    throw new Error(
      `Flux runner is not the expected CPU-only build: ${JSON.stringify(capabilities)}`,
    );
  }
  const protocol = runJsonProbe(
    path,
    ["--protocol-smoke"],
    '{"type":"shutdown"}\n',
  );
  if (
    protocol?.backend !== "cpu-native" ||
    protocol?.request !== "shutdown" ||
    protocol?.ok !== true ||
    protocol?.protocol_version !== 1
  ) {
    throw new Error(
      `Flux CPU protocol smoke failed: ${JSON.stringify(protocol)}`,
    );
  }
}

/** @param {string} path @param {string[]} probeArgs @param {string} [input] */
function runJsonProbe(path, probeArgs, input) {
  const result = spawnSync(path, probeArgs, {
    cwd: root,
    encoding: "utf8",
    input,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${basename(path)} ${probeArgs.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  const line = String(result.stdout || "")
    .split(/\r?\n/u)
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line)
    throw new Error(`${basename(path)} returned no JSON probe output.`);
  return JSON.parse(line);
}

function readGitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("Unable to resolve the producer commit.");
  const commit = String(result.stdout || "").trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(`Invalid producer commit: ${commit}`);
  }
  return commit;
}

/** @param {string} path */
function isUsableExecutable(path) {
  return (
    existsSync(path) &&
    statSync(path).isFile() &&
    statSync(path).size > 1024 * 1024
  );
}

/** @param {Buffer} value */
function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} path */
function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

/** @param {unknown} value @param {string} label */
function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
}

/** @param {unknown} value @param {string} label */
function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ outputDir?: string; releaseTag?: string; sourceCommit?: string; verifyDir?: string }} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--output-dir",
        "--release-tag",
        "--source-commit",
        "--verify-dir",
      ].includes(key)
    ) {
      throw new Error(`Unknown argument: ${key}`);
    }
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === "--output-dir") parsed.outputDir = value;
    if (key === "--release-tag") parsed.releaseTag = value;
    if (key === "--source-commit") parsed.sourceCommit = value;
    if (key === "--verify-dir") parsed.verifyDir = value;
    index += 1;
  }
  return parsed;
}
