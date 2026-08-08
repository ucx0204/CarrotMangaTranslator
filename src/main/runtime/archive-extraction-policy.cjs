// @ts-check

const MAX_RUNTIME_ARCHIVE_ENTRY_COUNT = 10_000;
const MAX_RUNTIME_ARCHIVE_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_RUNTIME_ARCHIVE_COMPRESSION_RATIO = 100;
const RUNTIME_ARCHIVE_EXTRACTION_DEADLINE_MS = 5 * 60 * 1000;

const DEFAULT_RUNTIME_ARCHIVE_EXTRACTION_LIMITS = Object.freeze({
  maximumEntries: MAX_RUNTIME_ARCHIVE_ENTRY_COUNT,
  maximumEntryBytes: MAX_RUNTIME_ARCHIVE_ENTRY_BYTES,
  maximumExpandedBytes: MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES,
  maximumCompressionRatio: MAX_RUNTIME_ARCHIVE_COMPRESSION_RATIO,
});

/**
 * @typedef {{ maximumEntries: number; maximumEntryBytes: number; maximumExpandedBytes: number; maximumCompressionRatio: number }} ArchiveExtractionLimits
 */

/**
 * @param {Partial<ArchiveExtractionLimits> | null | undefined} [overrides]
 * @returns {ArchiveExtractionLimits}
 */
function resolveArchiveExtractionLimits(overrides = {}) {
  return {
    maximumEntries: readPositiveSafeLimit(
      overrides?.maximumEntries,
      MAX_RUNTIME_ARCHIVE_ENTRY_COUNT,
      "maximumEntries",
    ),
    maximumEntryBytes: readPositiveSafeLimit(
      overrides?.maximumEntryBytes,
      MAX_RUNTIME_ARCHIVE_ENTRY_BYTES,
      "maximumEntryBytes",
    ),
    maximumExpandedBytes: readPositiveSafeLimit(
      overrides?.maximumExpandedBytes,
      MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES,
      "maximumExpandedBytes",
    ),
    maximumCompressionRatio: readPositiveFiniteLimit(
      overrides?.maximumCompressionRatio,
      MAX_RUNTIME_ARCHIVE_COMPRESSION_RATIO,
      "maximumCompressionRatio",
    ),
  };
}

/** @param {unknown} value @param {number} fallback @param {string} label */
function readPositiveSafeLimit(value, fallback, label) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

/** @param {unknown} value @param {number} fallback @param {string} label */
function readPositiveFiniteLimit(value, fallback, label) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return resolved;
}

/**
 * @param {{ entryCount: number; expandedBytes: number }} budget
 * @param {{ name: string; size: unknown; compressedSize?: unknown; directory?: boolean }} entry
 * @param {string} archiveLabel
 * @param {ArchiveExtractionLimits} [limits]
 */
function addArchiveEntryToBudget(
  budget,
  entry,
  archiveLabel,
  limits = DEFAULT_RUNTIME_ARCHIVE_EXTRACTION_LIMITS,
) {
  budget.entryCount += 1;
  if (budget.entryCount > limits.maximumEntries) {
    throw new Error(`${archiveLabel} contains too many entries.`);
  }
  if (entry.directory) return;
  const size = readArchiveEntrySize(entry.size, archiveLabel, entry.name);
  assertArchiveEntrySizeLimit(
    size,
    archiveLabel,
    entry.name,
    limits.maximumEntryBytes,
  );
  assertArchiveCompressionRatio(
    entry,
    size,
    archiveLabel,
    limits.maximumCompressionRatio,
  );
  addExpandedArchiveBytes(
    budget,
    size,
    archiveLabel,
    limits.maximumExpandedBytes,
  );
}

/** @param {unknown} value @param {string} archiveLabel @param {string} entryName */
function readArchiveEntrySize(value, archiveLabel, entryName) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${archiveLabel} has an invalid entry size: ${entryName}`);
  }
  return size;
}

/** @param {number} size @param {string} archiveLabel @param {string} entryName @param {number} maximumEntryBytes */
function assertArchiveEntrySizeLimit(
  size,
  archiveLabel,
  entryName,
  maximumEntryBytes,
) {
  if (size > maximumEntryBytes) {
    throw new Error(`${archiveLabel} entry is too large: ${entryName}`);
  }
}

/** @param {{ name: string; compressedSize?: unknown }} entry @param {number} size @param {string} archiveLabel @param {number} maximumCompressionRatio */
function assertArchiveCompressionRatio(
  entry,
  size,
  archiveLabel,
  maximumCompressionRatio,
) {
  if (entry.compressedSize === undefined) return;
  const compressedSize = readArchiveEntrySize(
    entry.compressedSize,
    archiveLabel,
    entry.name,
  );
  const ratio = compressedSize > 0 ? size / compressedSize : Infinity;
  if (size > 0 && ratio > maximumCompressionRatio) {
    throw new Error(
      `${archiveLabel} has a suspicious compression ratio: ${entry.name}`,
    );
  }
}

/** @param {{ expandedBytes: number }} budget @param {number} size @param {string} archiveLabel @param {number} maximumExpandedBytes */
function addExpandedArchiveBytes(
  budget,
  size,
  archiveLabel,
  maximumExpandedBytes,
) {
  budget.expandedBytes += size;
  if (
    !Number.isSafeInteger(budget.expandedBytes) ||
    budget.expandedBytes > maximumExpandedBytes
  ) {
    throw new Error(`${archiveLabel} expands beyond the allowed size.`);
  }
}

/** @param {AbortSignal | null | undefined} signal */
function throwIfArchiveExtractionAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Archive extraction aborted", "AbortError");
  }
}

/**
 * @param {AbortSignal | null | undefined} parentSignal
 * @param {number} [deadlineMs]
 */
function createArchiveExtractionDeadline(
  parentSignal,
  deadlineMs = RUNTIME_ARCHIVE_EXTRACTION_DEADLINE_MS,
) {
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(
      parentSignal?.reason ??
        new DOMException("Archive extraction aborted", "AbortError"),
    );
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error("Archive extraction deadline exceeded."));
  }, deadlineMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

module.exports = {
  DEFAULT_RUNTIME_ARCHIVE_EXTRACTION_LIMITS,
  MAX_RUNTIME_ARCHIVE_COMPRESSION_RATIO,
  MAX_RUNTIME_ARCHIVE_ENTRY_BYTES,
  MAX_RUNTIME_ARCHIVE_ENTRY_COUNT,
  MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES,
  RUNTIME_ARCHIVE_EXTRACTION_DEADLINE_MS,
  addArchiveEntryToBudget,
  createArchiveExtractionDeadline,
  resolveArchiveExtractionLimits,
  throwIfArchiveExtractionAborted,
};
