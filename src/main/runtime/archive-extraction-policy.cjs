// @ts-check

const MAX_RUNTIME_ARCHIVE_ENTRY_COUNT = 10_000;
const MAX_RUNTIME_ARCHIVE_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_RUNTIME_ARCHIVE_COMPRESSION_RATIO = 100;
const RUNTIME_ARCHIVE_EXTRACTION_DEADLINE_MS = 5 * 60 * 1000;

/**
 * @param {{ entryCount: number; expandedBytes: number }} budget
 * @param {{ name: string; size: unknown; compressedSize?: unknown; directory?: boolean }} entry
 * @param {string} archiveLabel
 */
function addArchiveEntryToBudget(budget, entry, archiveLabel) {
  budget.entryCount += 1;
  if (budget.entryCount > MAX_RUNTIME_ARCHIVE_ENTRY_COUNT) {
    throw new Error(`${archiveLabel} contains too many entries.`);
  }
  if (entry.directory) return;
  const size = readArchiveEntrySize(entry.size, archiveLabel, entry.name);
  assertArchiveEntrySizeLimit(size, archiveLabel, entry.name);
  assertArchiveCompressionRatio(entry, size, archiveLabel);
  addExpandedArchiveBytes(budget, size, archiveLabel);
}

/** @param {unknown} value @param {string} archiveLabel @param {string} entryName */
function readArchiveEntrySize(value, archiveLabel, entryName) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${archiveLabel} has an invalid entry size: ${entryName}`);
  }
  return size;
}

/** @param {number} size @param {string} archiveLabel @param {string} entryName */
function assertArchiveEntrySizeLimit(size, archiveLabel, entryName) {
  if (size > MAX_RUNTIME_ARCHIVE_ENTRY_BYTES) {
    throw new Error(`${archiveLabel} entry is too large: ${entryName}`);
  }
}

/** @param {{ name: string; compressedSize?: unknown }} entry @param {number} size @param {string} archiveLabel */
function assertArchiveCompressionRatio(entry, size, archiveLabel) {
  if (entry.compressedSize === undefined) return;
  const compressedSize = readArchiveEntrySize(
    entry.compressedSize,
    archiveLabel,
    entry.name,
  );
  const ratio = compressedSize > 0 ? size / compressedSize : Infinity;
  if (size > 0 && ratio > MAX_RUNTIME_ARCHIVE_COMPRESSION_RATIO) {
    throw new Error(
      `${archiveLabel} has a suspicious compression ratio: ${entry.name}`,
    );
  }
}

/** @param {{ expandedBytes: number }} budget @param {number} size @param {string} archiveLabel */
function addExpandedArchiveBytes(budget, size, archiveLabel) {
  budget.expandedBytes += size;
  if (
    !Number.isSafeInteger(budget.expandedBytes) ||
    budget.expandedBytes > MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES
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
  MAX_RUNTIME_ARCHIVE_COMPRESSION_RATIO,
  MAX_RUNTIME_ARCHIVE_ENTRY_BYTES,
  MAX_RUNTIME_ARCHIVE_ENTRY_COUNT,
  MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES,
  RUNTIME_ARCHIVE_EXTRACTION_DEADLINE_MS,
  addArchiveEntryToBudget,
  createArchiveExtractionDeadline,
  throwIfArchiveExtractionAborted,
};
