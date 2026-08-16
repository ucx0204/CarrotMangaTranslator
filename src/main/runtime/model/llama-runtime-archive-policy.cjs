// @ts-check

const { randomUUID } = require("node:crypto");
const { lstat, rename, rm } = require("node:fs/promises");
const path = require("node:path");

const {
  MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES,
} = require("../archive-extraction-policy.cjs");
const {
  MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
} = require("../transport/download-budgets.cjs");

/** @typedef {{ originalPath: string; ownedPath: string; restored: boolean }} RuntimeArchiveClaim */
/** @typedef {{ archive?: unknown; url?: unknown; sha256?: unknown; expectedBytes?: unknown; type?: unknown; stripComponents?: unknown }} RuntimeArchiveDescriptor */

const BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT = Object.freeze({
  runtimeId: "beellama-v0.3.1-hip-radeon",
  runtimeKind: "beellama-hip",
  backend: "rocm",
  archive: "beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
  url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.3.1/beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
  sha256: "53302ae602dc43381f1c61794c2508a5e72931916b6de015531683358dc78fbc",
  bytes: 553_375_639,
});

// Runtime archives are owned, hashed before extraction, and hashed again
// before publication. Once a descriptor's SHA-256 and exact byte size match,
// the total expanded-size budget is the effective single-entry ceiling too.
// Unverified ZIP/TAR callers keep the shared 1-GiB per-entry default.
const VERIFIED_LLAMA_RUNTIME_EXTRACTION_LIMITS = Object.freeze({
  maximumEntryBytes: MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES,
});

/** @param {RuntimeArchiveDescriptor} left @param {RuntimeArchiveDescriptor} right */
function runtimeArchiveDescriptorsMatch(left, right) {
  if (!left || !right) return false;
  return [
    left.archive === right.archive,
    left.url === right.url,
    normalizeSha256(left.sha256) === normalizeSha256(right.sha256),
    left.expectedBytes === right.expectedBytes,
    (left.type ?? "zip") === (right.type ?? "zip"),
    (left.stripComponents ?? 0) === (right.stripComponents ?? 0),
  ].every(Boolean);
}

/** @param {{ archives?: RuntimeArchiveDescriptor[] } | null | undefined} runtime @param {RuntimeArchiveDescriptor} archive */
function runtimeContainsArchiveDescriptor(runtime, archive) {
  return Boolean(
    Array.isArray(runtime?.archives) &&
    runtime.archives.some((candidate) =>
      runtimeArchiveDescriptorsMatch(candidate, archive),
    ),
  );
}

/**
 * @param {{ archives?: RuntimeArchiveDescriptor[] } | null | undefined} runtime
 * @param {RuntimeArchiveDescriptor} archive
 * @param {{ sha256?: unknown; bytes?: unknown }} verification
 */
function resolveVerifiedLlamaRuntimeExtractionLimits(
  runtime,
  archive,
  verification,
) {
  const expectedSha256 = normalizeSha256(archive?.sha256);
  const expectedBytes = readExpectedRuntimeArchiveBytes(archive);
  if (!expectedSha256 || expectedBytes === undefined) return undefined;
  if (!runtimeContainsArchiveDescriptor(runtime, archive)) return undefined;
  if (normalizeSha256(verification?.sha256) !== expectedSha256)
    return undefined;
  if (verification?.bytes !== expectedBytes) return undefined;
  return VERIFIED_LLAMA_RUNTIME_EXTRACTION_LIMITS;
}

/**
 * @param {{ id?: unknown; archives?: RuntimeArchiveDescriptor[] } | null | undefined} runtime
 * @param {RuntimeArchiveDescriptor} archive
 * @param {{ sha256?: unknown; bytes?: unknown }} verification
 */
function requireVerifiedLlamaRuntimeExtractionLimits(
  runtime,
  archive,
  verification,
) {
  const limits = resolveVerifiedLlamaRuntimeExtractionLimits(
    runtime,
    archive,
    verification,
  );
  if (limits) return limits;
  throw Object.assign(
    new Error(
      "검증된 Gemma 실행 런타임과 내장 압축 자산 계약이 일치하지 않습니다.",
    ),
    { archive: archive.archive, runtimeId: runtime?.id },
  );
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
  const expectedBytes = readExpectedRuntimeArchiveBytes(archive);
  if (expectedBytes === undefined) {
    throw new TypeError(
      "Gemma 실행 런타임 descriptor에 expectedBytes가 필요합니다.",
    );
  }
  return expectedBytes;
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
    try {
      resolveRuntimeArchiveMaximumBytes(archive);
    } catch (cause) {
      throw Object.assign(
        new Error(
          "Gemma 실행 런타임 descriptor에 유효한 expectedBytes가 필요합니다.",
          { cause },
        ),
        { archive: archive.archive, url: archive.url },
      );
    }
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
  requireVerifiedLlamaRuntimeExtractionLimits,
  resolveVerifiedLlamaRuntimeExtractionLimits,
  resolveRuntimeArchiveMaximumBytes,
};
