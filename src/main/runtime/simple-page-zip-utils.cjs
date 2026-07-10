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
 * @typedef {{ command: string, args: string[], code: number | null, stdout: string, stderr: string, error?: string }} ArchiveCommandAttempt
 * @typedef {{ method: "powershell" | "tar", stdout: string, stderr: string, attempts: ArchiveCommandAttempt[] }} ArchiveExtractionResult
 * @typedef {(archivePath: string, outputDir: string) => Promise<ArchiveExtractionResult>} ArchiveExtractor
 * @typedef {{ extractArchive?: ArchiveExtractor }} ExtractSelectedZipOptions
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
 * @param {ExtractSelectedZipOptions} [options]
 * @returns {Promise<void>}
 */
async function extractSelectedZipEntries(
  archivePath,
  outputDir,
  shouldExtract,
  options = {},
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
    const extractArchive = options.extractArchive ?? expandZipArchive;
    const extraction = await extractArchive(archivePath, extractDir);
    const selectedFiles = collectSelectedFiles(extractDir, shouldExtract);
    if (selectedFiles.length === 0) {
      throw createDetailedError(
        `No runtime files matched in ${archivePath}. Archive extraction completed but produced no supported runtime files.`,
        {
          archivePath,
          extractDir,
          stdout: truncateText(extraction.stdout.trim(), 4000),
          stderr: truncateText(extraction.stderr.trim(), 4000),
          extractedTopLevelEntries: readTopLevelEntries(extractDir),
          extractionMethod: extraction.method,
          extractionAttempts: extraction.attempts,
        },
      );
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
 * @returns {Promise<ArchiveExtractionResult>}
 */
async function expandZipArchive(archivePath, outputDir) {
  if (process.platform !== "win32") {
    throw new Error(
      "Default Gemma runtime auto-install is only supported on Windows.",
    );
  }
  const psScript =
    "& { param($zip, $dest) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force -ErrorAction Stop }";
  /** @type {ArchiveCommandAttempt[]} */
  const attempts = [];
  const env = buildUtilityChildEnv({});
  const powerShellAttempt = await runArchiveCommand(
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
    { env },
  );
  attempts.push(powerShellAttempt);
  if (isSuccessfulCommandAttempt(powerShellAttempt)) {
    return buildExtractionResult("powershell", attempts);
  }

  await resetExtractionDirectory(outputDir);
  const tarListAttempt = await runArchiveCommand(
    "tar.exe",
    ["-tf", archivePath],
    { cwd: outputDir, env },
  );
  attempts.push(tarListAttempt);
  if (!isSuccessfulCommandAttempt(tarListAttempt)) {
    throw createArchiveExtractionError(archivePath, outputDir, attempts);
  }

  try {
    validateArchiveEntries(
      parseTarArchiveEntries(tarListAttempt.stdout),
      archivePath,
      outputDir,
    );
  } catch (error) {
    throw createDetailedError(
      "Runtime zip archive contains unsafe or unreadable entries.",
      buildExtractionErrorDetail(archivePath, outputDir, attempts),
      error,
    );
  }

  const tarExtractAttempt = await runArchiveCommand(
    "tar.exe",
    ["-xf", archivePath, "-C", outputDir],
    { cwd: outputDir, env },
  );
  attempts.push(tarExtractAttempt);
  if (isSuccessfulCommandAttempt(tarExtractAttempt)) {
    return buildExtractionResult("tar", attempts);
  }
  throw createArchiveExtractionError(archivePath, outputDir, attempts);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<ArchiveCommandAttempt>}
 */
function runArchiveCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      cwd: options.cwd,
      env: options.env,
    });
    /**
     * @param {number | null} code
     * @param {string} [error]
     * @returns {void}
     */
    const finish = (code, error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        command,
        args,
        code,
        stdout: truncateText(stdout.trim(), 4000),
        stderr: truncateText(stderr.trim(), 4000),
        ...(error ? { error } : {}),
      });
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 4000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 4000);
    });
    child.on("error", (error) => {
      finish(null, `${error.name}: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      finish(code, signal ? `terminated by signal ${signal}` : undefined);
    });
  });
}

/**
 * @param {ArchiveCommandAttempt} attempt
 * @returns {boolean}
 */
function isSuccessfulCommandAttempt(attempt) {
  return attempt.code === 0 && !attempt.error;
}

/**
 * @param {"powershell" | "tar"} method
 * @param {ArchiveCommandAttempt[]} attempts
 * @returns {ArchiveExtractionResult}
 */
function buildExtractionResult(method, attempts) {
  return {
    method,
    stdout: combineAttemptStream(attempts, "stdout"),
    stderr: combineAttemptStream(attempts, "stderr"),
    attempts,
  };
}

/**
 * @param {string} archivePath
 * @param {string} outputDir
 * @param {ArchiveCommandAttempt[]} attempts
 * @returns {Error & Record<string, unknown>}
 */
function createArchiveExtractionError(archivePath, outputDir, attempts) {
  return createDetailedError(
    "Failed to extract runtime zip archive with Expand-Archive or tar.exe.",
    buildExtractionErrorDetail(archivePath, outputDir, attempts),
  );
}

/**
 * @param {string} archivePath
 * @param {string} outputDir
 * @param {ArchiveCommandAttempt[]} attempts
 * @returns {Record<string, unknown>}
 */
function buildExtractionErrorDetail(archivePath, outputDir, attempts) {
  return {
    archivePath,
    outputDir,
    stdout: combineAttemptStream(attempts, "stdout"),
    stderr: combineAttemptStream(attempts, "stderr"),
    extractionAttempts: attempts,
  };
}

/**
 * @param {ArchiveCommandAttempt[]} attempts
 * @param {"stdout" | "stderr"} stream
 * @returns {string}
 */
function combineAttemptStream(attempts, stream) {
  const text = attempts
    .map((attempt) => {
      const output = attempt[stream].trim();
      const extra = stream === "stderr" && attempt.error ? attempt.error : "";
      const value = [output, extra].filter(Boolean).join("\n");
      return value ? `[${attempt.command}] ${value}` : "";
    })
    .filter(Boolean)
    .join("\n");
  return truncateText(text, 4000);
}

/**
 * @param {string} outputDir
 * @returns {Promise<void>}
 */
async function resetExtractionDirectory(outputDir) {
  await safeCleanup("remove failed runtime extract output", () =>
    rm(outputDir, { recursive: true, force: true }),
  );
  await mkdir(outputDir, { recursive: true });
}

/**
 * @param {string} stdout
 * @returns {string[]}
 */
function parseTarArchiveEntries(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} entries
 * @param {string} archivePath
 * @param {string} outputRoot
 * @returns {void}
 */
function validateArchiveEntries(entries, archivePath, outputRoot) {
  if (entries.length === 0) {
    throw new Error(`${path.basename(archivePath)} archive is empty.`);
  }
  const root = path.resolve(outputRoot);
  for (const rawEntry of entries) {
    const entryName = path
      .normalize(rawEntry)
      .replace(/^([/\\])+/, "")
      .replace(/^\.([/\\])+/, "");
    if (!entryName || entryName === ".") {
      continue;
    }
    if (
      entryName.startsWith("..") ||
      /^[a-zA-Z]:/.test(entryName) ||
      path.isAbsolute(entryName)
    ) {
      throw new Error(
        `${path.basename(archivePath)} contains an unsafe entry path: ${rawEntry}`,
      );
    }
    const destination = path.resolve(root, entryName);
    if (!isPathInside(destination, root)) {
      throw new Error(
        `${path.basename(archivePath)} contains an unsafe entry path: ${rawEntry}`,
      );
    }
  }
}

/**
 * @param {string} rootDir
 * @returns {string[]}
 */
function readTopLevelEntries(rootDir) {
  try {
    return readdirSync(rootDir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (_error) {
    return [];
  }
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
