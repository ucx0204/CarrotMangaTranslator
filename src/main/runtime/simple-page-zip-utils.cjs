// @ts-check
const { spawn } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { copyFile, mkdir, rm } = require("node:fs/promises");
const path = require("node:path");

const { buildUtilityChildEnv } = require("./simple-page-child-env.cjs");
const { safeCleanup } = require("./simple-page-runtime-common.cjs");

/**
 * @typedef {{ filePath: string; outputName: string }} SelectedRuntimeFile
 * @typedef {(name: string, relativePath: string) => boolean} RuntimeEntryFilter
 */

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function truncateText(value, maxLength = 4000) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 * @param {unknown} [cause]
 * @returns {Error & Record<string, unknown>}
 */
function createDetailedError(message, detail = {}, cause) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(message)
  );
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}

/**
 * @param {string} current
 * @param {unknown} chunk
 * @param {number} [maxLength]
 * @returns {string}
 */
function shrinkBuffer(current, chunk, maxLength = 12000) {
  const next = `${current}${chunk}`;
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

/**
 * @param {string} archivePath
 * @param {string} outputDir
 * @param {RuntimeEntryFilter} shouldExtract
 * @returns {Promise<void>}
 */
async function extractSelectedZipEntries(
  archivePath,
  outputDir,
  shouldExtract,
) {
  const extractDir = path.join(
    path.dirname(outputDir),
    `${path.basename(outputDir)}.extract-${process.pid}-${Date.now()}`,
  );
  const resolvedOutputDir = path.resolve(outputDir);
  await safeCleanup("remove previous runtime extract directory", () =>
    rm(extractDir, { recursive: true, force: true }),
  );
  await mkdir(extractDir, { recursive: true });
  try {
    await expandZipArchive(archivePath, extractDir);
    const selectedFiles = collectSelectedFiles(extractDir, shouldExtract);
    if (selectedFiles.length === 0) {
      throw new Error(`No runtime files matched in ${archivePath}`);
    }
    for (const selected of selectedFiles) {
      const filePath =
        typeof selected === "string" ? selected : selected.filePath;
      const outputName =
        typeof selected === "string"
          ? path.basename(filePath)
          : selected.outputName;
      const outputPath = path.join(outputDir, outputName);
      const resolvedOutputPath = path.resolve(outputPath);
      if (!isPathInside(resolvedOutputPath, resolvedOutputDir)) {
        throw new Error(`Invalid runtime output path: ${outputName}`);
      }
      await mkdir(path.dirname(outputPath), { recursive: true });
      await copyFile(filePath, outputPath);
    }
  } finally {
    await safeCleanup("remove runtime extract directory", () =>
      rm(extractDir, { recursive: true, force: true }),
    );
  }
}

/**
 * @param {string} archivePath
 * @param {string} outputDir
 * @returns {Promise<void>}
 */
async function expandZipArchive(archivePath, outputDir) {
  if (process.platform !== "win32") {
    throw new Error(
      "Default Gemma runtime auto-install is only supported on Windows.",
    );
  }
  const psScript =
    "& { param($zip, $dest) Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }";
  /** @type {Promise<void>} */
  const completed = new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        psScript,
        archivePath,
        outputDir,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: buildUtilityChildEnv({}),
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 4000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 4000);
    });
    child.on("error", (error) => {
      reject(
        createDetailedError(
          "Failed to launch Expand-Archive.",
          {
            archivePath,
            outputDir,
            stdout: truncateText(stdout, 4000),
            stderr: truncateText(stderr, 4000),
          },
          error,
        ),
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        createDetailedError(`Expand-Archive failed (${code ?? "null"}).`, {
          archivePath,
          outputDir,
          stdout: truncateText(stdout.trim(), 4000),
          stderr: truncateText(stderr.trim(), 4000),
        }),
      );
    });
  });
  await completed;
}

/**
 * @param {string} rootDir
 * @param {RuntimeEntryFilter} shouldExtract
 * @returns {SelectedRuntimeFile[]}
 */
function collectSelectedFiles(rootDir, shouldExtract) {
  /** @type {SelectedRuntimeFile[]} */
  const selected = [];
  const stack = [{ dir: rootDir, relativeDir: "" }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const currentDir = current.dir;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(currentDir, entry.name);
      const relativePath = current.relativeDir
        ? path.join(current.relativeDir, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        stack.push({ dir: filePath, relativeDir: relativePath });
        continue;
      }
      if (entry.isFile() && shouldExtract(entry.name, relativePath)) {
        selected.push({
          filePath,
          outputName: shouldPreserveRuntimeRelativePath(relativePath)
            ? relativePath
            : entry.name,
        });
      }
    }
  }
  return selected;
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function shouldPreserveRuntimeRelativePath(relativePath) {
  const normalized = String(relativePath || "")
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    normalized.startsWith("rocblas/") || normalized.startsWith("hipblaslt/")
  );
}

/**
 * @param {string} childPath
 * @param {string} parentPath
 * @returns {boolean}
 */
function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

module.exports = {
  collectSelectedFiles,
  expandZipArchive,
  extractSelectedZipEntries,
};
