const { spawn } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { copyFile, mkdir, rm } = require("node:fs/promises");
const path = require("node:path");

const { buildUtilityChildEnv } = require("./simple-page-child-env.cjs");

function truncateText(value, maxLength = 4000) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function createDetailedError(message, detail = {}, cause) {
  const error = new Error(message);
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}

function shrinkBuffer(current, chunk, maxLength = 12000) {
  const next = `${current}${chunk}`;
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

async function extractSelectedZipEntries(archivePath, outputDir, shouldExtract) {
  const extractDir = path.join(path.dirname(outputDir), `${path.basename(outputDir)}.extract-${process.pid}-${Date.now()}`);
  await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(extractDir, { recursive: true });
  try {
    await expandZipArchive(archivePath, extractDir);
    const selectedFiles = collectSelectedFiles(extractDir, shouldExtract);
    if (selectedFiles.length === 0) {
      throw new Error(`No runtime files matched in ${archivePath}`);
    }
    for (const filePath of selectedFiles) {
      const fileName = path.basename(filePath);
      const outputPath = path.join(outputDir, fileName);
      if (!path.resolve(outputPath).startsWith(path.resolve(outputDir))) {
        throw new Error(`Invalid runtime output path: ${fileName}`);
      }
      await copyFile(filePath, outputPath);
    }
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function expandZipArchive(archivePath, outputDir) {
  if (process.platform !== "win32") {
    throw new Error("Default Gemma runtime auto-install is only supported on Windows.");
  }
  const psScript = "& { param($zip, $dest) Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }";
  await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript, archivePath, outputDir],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: buildUtilityChildEnv({})
      }
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
      reject(createDetailedError("Failed to launch Expand-Archive.", {
        archivePath,
        outputDir,
        stdout: truncateText(stdout, 4000),
        stderr: truncateText(stderr, 4000)
      }, error));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(createDetailedError(`Expand-Archive failed (${code ?? "null"}).`, {
        archivePath,
        outputDir,
        stdout: truncateText(stdout.trim(), 4000),
        stderr: truncateText(stderr.trim(), 4000)
      }));
    });
  });
}

function collectSelectedFiles(rootDir, shouldExtract) {
  const selected = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (entry.isFile() && shouldExtract(entry.name)) {
        selected.push(filePath);
      }
    }
  }
  return selected;
}

module.exports = {
  collectSelectedFiles,
  expandZipArchive,
  extractSelectedZipEntries
};
