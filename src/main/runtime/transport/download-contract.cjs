// @ts-check
const path = require("node:path");
const {
  assertDownloadMaximumBytes,
  assertDownloadSizeWithinBudget,
  createDownloadError,
} = require("./download-budget-utils.cjs");
const { normalizeExpectedSha256 } = require("./download-integrity.cjs");

const WINDOWS_LEGACY_PATH_CEILING = 252;
const REMOTE_METADATA_TEMP_BASENAME = ".m-0000000000000000";
const DOWNLOAD_DERIVED_PATHS = Object.freeze([
  ["partial", ".part"],
  ["remote-metadata", ".mgtmeta.json"],
  ["integrity-metadata", ".mgt-sha256.json"],
]);

/**
 * @typedef {{ url: string; file: string; destination: string; label: string; maximumBytes: number; minimumBytes?: number; expectedTotalBytes?: number; expectedSha256?: string }} DownloadContractTask
 * @typedef {{ expectedSha256: string | null; expectedTotalBytes: number | null; minimumBytes: number | null }} DownloadContract
 * @typedef {Readonly<{ receivedBytes: number; verifiedSha256: string | null; size: number; mtimeMs: number }>} DownloadCompletionReceipt
 */

/** @param {DownloadContractTask} task @param {{ totalBytes?: number }} progress @returns {DownloadContract} */
function validateDownloadContract(task, progress) {
  assertDownloadMaximumBytes(task);
  const expectedSha256 = normalizeExpectedSha256(task.expectedSha256) || null;
  if (task.expectedSha256 !== undefined && !expectedSha256) {
    fail(task, "다운로드 SHA-256 값이 올바르지 않습니다.", {
      downloadIntegrityInvalid: true,
    });
  }
  assertMinimumBytes(task);
  assertExpectedTotalBytes(task);
  assertWindowsDownloadPathBudget(task);
  if (progress.totalBytes !== undefined && progress.totalBytes > 0) {
    assertDownloadSizeWithinBudget(task, progress.totalBytes);
  }
  return {
    expectedSha256,
    expectedTotalBytes: task.expectedTotalBytes ?? null,
    minimumBytes: task.minimumBytes ?? null,
  };
}

/** @param {DownloadContractTask} task */
function assertWindowsDownloadPathBudget(task) {
  if (
    process.platform !== "win32" ||
    String(task.destination).startsWith("\\\\?\\")
  ) {
    return;
  }
  const derived = DOWNLOAD_DERIVED_PATHS.map(([kind, suffix]) => ({
    kind,
    filePath: path.resolve(`${task.destination}${suffix}`),
  }))
    .concat({
      kind: "remote-metadata-temp",
      filePath: path.resolve(
        path.dirname(task.destination),
        REMOTE_METADATA_TEMP_BASENAME,
      ),
    })
    .sort((left, right) => right.filePath.length - left.filePath.length)[0];
  if (!derived || derived.filePath.length < WINDOWS_LEGACY_PATH_CEILING) {
    return;
  }
  fail(task, "Windows 파생 다운로드 경로가 너무 깁니다.", {
    derivedPath: derived.filePath,
    derivedPathKind: derived.kind,
    derivedPathLength: derived.filePath.length,
    windowsPathCeiling: WINDOWS_LEGACY_PATH_CEILING,
    windowsPathUnsafe: true,
  });
}

/** @param {DownloadContractTask} task */
function assertMinimumBytes(task) {
  if (
    task.minimumBytes !== undefined &&
    (!Number.isSafeInteger(task.minimumBytes) ||
      task.minimumBytes < 1 ||
      task.minimumBytes > task.maximumBytes)
  ) {
    fail(task, "다운로드 최소 크기가 올바르지 않습니다.", {
      minimumBytes: task.minimumBytes,
      downloadBudgetInvalid: true,
    });
  }
}

/** @param {DownloadContractTask} task */
function assertExpectedTotalBytes(task) {
  if (task.expectedTotalBytes === undefined) return;
  assertDownloadSizeWithinBudget(task, task.expectedTotalBytes);
  if (
    task.expectedTotalBytes < 1 ||
    (task.minimumBytes !== undefined &&
      task.expectedTotalBytes < task.minimumBytes)
  ) {
    fail(task, "예상 다운로드 크기가 올바르지 않습니다.", {
      minimumBytes: task.minimumBytes,
      expectedTotalBytes: task.expectedTotalBytes,
      downloadBudgetInvalid: true,
    });
  }
}

/** @param {DownloadContractTask} task @param {number} receivedBytes */
function assertReceivedSize(task, receivedBytes) {
  assertDownloadSizeWithinBudget(task, receivedBytes);
  if (
    task.expectedTotalBytes !== undefined &&
    receivedBytes !== task.expectedTotalBytes
  ) {
    fail(task, "다운로드 크기가 고정된 예상 크기와 다릅니다.", {
      expectedTotalBytes: task.expectedTotalBytes,
      receivedBytes,
    });
  }
  if (task.minimumBytes !== undefined && receivedBytes < task.minimumBytes) {
    fail(task, "다운로드가 최소 크기에 미치지 못했습니다.", {
      minimumBytes: task.minimumBytes,
      receivedBytes,
    });
  }
}

/** @param {{ url: string; maximumBytes: number; expectedSha256: string | null; expectedTotalBytes: number | null; minimumBytes: number | null }} active @param {DownloadContractTask} task @param {DownloadContract} contract */
function assertCompatibleActiveDownload(active, task, contract) {
  if (active.url !== task.url) {
    mismatch(task, "url", active.url, task.url);
  }
  if (active.maximumBytes > task.maximumBytes) {
    throw detailedDownloadError(
      "더 엄격한 다운로드 크기 제한으로 진행 중인 다운로드에 연결할 수 없습니다.",
      task,
      {
        destination: task.destination,
        activeMaximumBytes: active.maximumBytes,
        requestedMaximumBytes: task.maximumBytes,
        downloadBudgetMismatch: true,
        nonRetriable: true,
      },
    );
  }
  const fields = /** @type {(keyof DownloadContract)[]} */ ([
    "expectedSha256",
    "expectedTotalBytes",
    "minimumBytes",
  ]);
  for (const field of fields) {
    if (active[field] !== contract[field]) {
      mismatch(task, field, active[field], contract[field]);
    }
  }
}

/** @param {DownloadContractTask} task @param {DownloadContract} contract @param {DownloadCompletionReceipt} receipt */
function assertReceiptMatchesTask(task, contract, receipt) {
  assertReceivedSize(task, receipt.receivedBytes);
  if (
    receipt.size !== receipt.receivedBytes ||
    receipt.verifiedSha256 !== contract.expectedSha256
  ) {
    fail(task, "완료 receipt가 요청 계약과 일치하지 않습니다.", {
      expectedSha256: contract.expectedSha256,
      receiptSha256: receipt.verifiedSha256,
      receiptBytes: receipt.receivedBytes,
      receiptSize: receipt.size,
      downloadContractMismatch: true,
    });
  }
}

/** @param {DownloadContractTask} task @param {string} field @param {unknown} activeValue @param {unknown} requestedValue */
function mismatch(task, field, activeValue, requestedValue) {
  fail(task, "같은 경로의 진행 중인 다운로드와 무결성 계약이 다릅니다.", {
    mismatchField: field,
    activeValue,
    requestedValue,
    downloadContractMismatch: true,
  });
}

/** @param {DownloadContractTask} task @param {string} message @param {Record<string, unknown>} details @returns {never} */
function fail(task, message, details) {
  throw detailedDownloadError(`${task.label} ${message}`, task, {
    file: task.file,
    destination: task.destination,
    ...details,
    nonRetriable: true,
  });
}

/** @param {string} message @param {DownloadContractTask} task @param {Record<string, unknown>} details */
function detailedDownloadError(message, task, details) {
  return Object.assign(createDownloadError(message, task), details);
}

module.exports = {
  assertCompatibleActiveDownload,
  assertReceiptMatchesTask,
  assertReceivedSize,
  validateDownloadContract,
};
