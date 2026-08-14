// @ts-check

const { randomUUID } = require("node:crypto");
const { lstat, rename, rm } = require("node:fs/promises");
const path = require("node:path");

const {
  MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
} = require("../transport/download-budgets.cjs");

/** @typedef {{ originalPath: string; ownedPath: string; restored: boolean }} RuntimeArchiveClaim */

const BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT = Object.freeze({
  runtimeId: "beellama-v0.3.1-hip-radeon",
  runtimeKind: "beellama-hip",
  backend: "rocm",
  archive: "beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
  url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.3.1/beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
  sha256: "53302ae602dc43381f1c61794c2508a5e72931916b6de015531683358dc78fbc",
  bytes: 553_375_639,
});

// The contract above contains ggml-hip.dll at exactly 1,515,477,504
// uncompressed bytes. Scope the exception to the verified asset instead of
// weakening the shared 1-GiB runtime-archive default for every ZIP and TAR.
const BEELLAMA_HIP_RADEON_ZIP_EXTRACTION_LIMITS = Object.freeze({
  maximumEntryBytes: 1_515_477_504,
});

/** @param {{ id?: unknown; kind?: unknown; backend?: unknown }} runtime */
function matchesPinnedRuntime(runtime) {
  return (
    runtime?.id === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.runtimeId &&
    runtime?.kind === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.runtimeKind &&
    runtime?.backend === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.backend
  );
}

/** @param {{ archive?: unknown; url?: unknown; sha256?: unknown; expectedBytes?: unknown }} archive */
function matchesPinnedArchive(archive) {
  return (
    archive?.archive === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.archive &&
    archive?.url === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.url &&
    archive?.sha256 === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.sha256 &&
    archive?.expectedBytes === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.bytes
  );
}

/** @param {{ sha256?: unknown; bytes?: unknown }} verification */
function matchesPinnedVerification(verification) {
  return (
    verification?.sha256 === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.sha256 &&
    verification?.bytes === BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.bytes
  );
}

/**
 * @param {{ id?: unknown; kind?: unknown; backend?: unknown }} runtime
 * @param {{ archive?: unknown; url?: unknown; sha256?: unknown; expectedBytes?: unknown }} archive
 * @param {{ sha256?: unknown; bytes?: unknown }} verification
 */
function resolvePinnedLlamaRuntimeZipExtractionLimits(
  runtime,
  archive,
  verification,
) {
  if (!matchesPinnedRuntime(runtime)) return undefined;
  if (!matchesPinnedArchive(archive)) return undefined;
  if (!matchesPinnedVerification(verification)) return undefined;
  return BEELLAMA_HIP_RADEON_ZIP_EXTRACTION_LIMITS;
}

/** @param {{ expectedBytes?: unknown } | null | undefined} archive */
function readExpectedRuntimeArchiveBytes(archive) {
  if (archive?.expectedBytes === undefined) return undefined;
  const expectedBytes = Number(archive.expectedBytes);
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAX_REMOTE_RUNTIME_ARCHIVE_BYTES
  ) {
    throw new TypeError(
      "Gemma 실행 런타임 expectedBytes는 허용 범위의 양의 정수여야 합니다.",
    );
  }
  return expectedBytes;
}

/** @param {{ expectedBytes?: unknown } | null | undefined} archive */
function resolveRuntimeArchiveMaximumBytes(archive) {
  return (
    readExpectedRuntimeArchiveBytes(archive) ?? MAX_REMOTE_RUNTIME_ARCHIVE_BYTES
  );
}

/** @param {Array<{ archive: string; url: string; sha256?: string; expectedBytes?: number }>} archives */
function assertRuntimeArchiveChecksumsPresent(archives) {
  if (archives.length === 0) {
    throw new Error("Gemma 실행 런타임 archive descriptor가 비어 있습니다.");
  }
  for (const archive of archives) {
    if (!normalizeSha256(archive.sha256)) {
      throw Object.assign(
        new Error(
          "Gemma 실행 런타임 descriptor에 유효한 SHA-256이 필요합니다.",
        ),
        { archive: archive.archive, url: archive.url },
      );
    }
    resolveRuntimeArchiveMaximumBytes(archive);
  }
}

/** @param {unknown} value */
function normalizeSha256(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

/**
 * Atomically detaches downloaded archives from their stable cache names before
 * verification. Extraction only sees the unpredictable owned paths; the
 * stable names are reclaimed with verified bytes before runtime publication.
 *
 * @param {string[]} archivePaths
 * @returns {Promise<Readonly<{ archivePaths: readonly string[]; restore: () => Promise<void> }>>}
 */
async function claimRuntimeArchivePaths(archivePaths) {
  /** @type {RuntimeArchiveClaim[]} */
  const claims = [];
  const restore = () => restoreRuntimeArchiveClaims(claims);
  try {
    for (const originalPath of archivePaths) {
      const ownedPath = path.join(
        path.dirname(originalPath),
        `.mgt-llama-archive-${randomUUID().replaceAll("-", "")}${runtimeArchiveSuffix(originalPath)}`,
      );
      const claim = { originalPath, ownedPath, restored: false };
      await rename(originalPath, ownedPath);
      claims.push(claim);
      const metadata = await lstat(ownedPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          `Gemma 실행 런타임 압축 파일이 일반 파일이 아니어서 설치를 중단했습니다: ${originalPath}`,
        );
      }
    }
  } catch (error) {
    try {
      await restore();
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Gemma 실행 런타임 압축 파일 소유권을 복구하지 못했습니다.",
        { cause: restoreError },
      );
    }
    throw error;
  }
  return Object.freeze({
    archivePaths: Object.freeze(claims.map(({ ownedPath }) => ownedPath)),
    restore,
  });
}

/** @param {string} archivePath */
function runtimeArchiveSuffix(archivePath) {
  const lowerName = path.basename(archivePath).toLowerCase();
  return lowerName.endsWith(".tar.gz") ? ".tar.gz" : path.extname(archivePath);
}

/** @param {RuntimeArchiveClaim[]} claims */
async function restoreRuntimeArchiveClaims(claims) {
  for (const claim of [...claims].reverse()) {
    if (claim.restored) continue;
    const ownedExists = await pathExistsWithoutFollowingLinks(claim.ownedPath);
    // Anything recreated at the public cache name was not the file that was
    // verified or extracted. Remove only that exact file/symlink; a directory
    // collision fails closed because recursive deletion is intentionally off.
    await rm(claim.originalPath, { force: true });
    if (ownedExists) await rename(claim.ownedPath, claim.originalPath);
    claim.restored = true;
  }
}

/** @param {string} filePath */
async function pathExistsWithoutFollowingLinks(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (/** @type {{ code?: unknown }} */ (error)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

module.exports = {
  BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT,
  assertRuntimeArchiveChecksumsPresent,
  claimRuntimeArchivePaths,
  normalizeSha256,
  readExpectedRuntimeArchiveBytes,
  resolvePinnedLlamaRuntimeZipExtractionLimits,
  resolveRuntimeArchiveMaximumBytes,
};
