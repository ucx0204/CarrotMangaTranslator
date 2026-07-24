/**
 * @typedef {{ line(text: string): void; raw(text: string): void; close(): void }} BuildLogger
 * @typedef {{ env: NodeJS.ProcessEnv; logger: BuildLogger; cwd?: string }} RunOptions
 */
const { spawn } = require("node:child_process");
const {
  createWriteStream,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { mkdir } = require("node:fs/promises");
const https = require("node:https");
const { basename, dirname, isAbsolute, join, resolve } = require("node:path");
const AdmZip = require("adm-zip");
const { rootDir } = require("./config.cjs");
const { formatBytes, quoteArg } = require("./build-utils.cjs");
const { isFile, isPathInside } = require("./windows-native-tools.cjs");

/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {Promise<void>}
 */
function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    options.logger.line(`> ${command} ${args.map(quoteArg).join(" ")}`);
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd || rootDir,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) =>
      options.logger.raw(chunk.toString("utf8")),
    );
    child.stderr.on("data", (chunk) =>
      options.logger.raw(chunk.toString("utf8")),
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit code ${code}`,
          ),
        );
      }
    });
  });
}

/**
 * @param {string} url
 * @param {string} outputPath
 * @param {BuildLogger} logger
 * @returns {Promise<void>}
 */
async function downloadFile(url, outputPath, logger) {
  if (isFile(outputPath) && statSync(outputPath).size > 0) {
    logger.line(`download cache: ${outputPath}`);
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  logger.line(`download: ${url}`);
  await new Promise((resolveDownload, reject) => {
    const file = createWriteStream(outputPath);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`GET ${url} failed with ${response.statusCode}`));
          return;
        }
        const total = Number(response.headers["content-length"] || 0);
        let received = 0;
        let lastLogAt = Date.now();
        response.on("data", (chunk) => {
          received += chunk.byteLength;
          const now = Date.now();
          if (now - lastLogAt > 1500) {
            lastLogAt = now;
            logger.line(
              `download progress: ${basename(outputPath)} ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""}`,
            );
          }
        });
        response.pipe(file);
        file.on("finish", () => file.close(resolveDownload));
        file.on("error", reject);
        response.on("error", reject);
      })
      .on("error", reject);
  });
  logger.line(
    `download complete: ${outputPath} (${formatBytes(statSync(outputPath).size)})`,
  );
}

/**
 * @param {string} archivePath
 * @param {string} outputDir
 * @returns {void}
 */
function extractZipSafely(archivePath, outputDir) {
  const zip = new AdmZip(archivePath);
  const root = resolve(outputDir);
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const entryName = item.entryName.replace(/^([/\\])+/, "");
    if (!entryName || entryName.startsWith("..") || isAbsolute(entryName)) {
      throw new Error(
        `${basename(archivePath)} contains unsafe path: ${item.entryName}`,
      );
    }
    const destination = resolve(root, entryName);
    if (!isPathInside(destination, root)) {
      throw new Error(
        `${basename(archivePath)} contains unsafe path: ${item.entryName}`,
      );
    }
    zip.extractEntryTo(item, root, true, true);
  }
}

/**
 * @param {string} outputDir
 * @returns {void}
 */
function sanitizeStandaloneEmbeddedPythonPathFile(outputDir) {
  const pthName =
    readdirSync(outputDir).find((name) => /^python\d+._pth$/i.test(name)) || "";
  if (!pthName) {
    return;
  }
  const pthPath = join(outputDir, pthName);
  const text = readFileSync(pthPath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .filter(
      (line) => line.trim() !== "#import site" && line.trim() !== "import site",
    )
    .filter((line) => line.trim());
  lines.push("import site");
  writeFileSync(pthPath, `${lines.join("\n")}\n`, "utf8");
}

/**
 * @param {string} pythonPath
 * @param {string} packageDir
 * @returns {void}
 */
function ensureEmbeddedPythonPackagePath(pythonPath, packageDir) {
  const pythonDir = dirname(resolve(pythonPath));
  const pthName =
    readdirSync(pythonDir).find((name) => /^python\d+._pth$/i.test(name)) || "";
  if (!pthName) {
    return;
  }
  const pthPath = join(pythonDir, pthName);
  const normalizedPackageDir = resolve(packageDir);
  const text = readFileSync(pthPath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== normalizedPackageDir)
    .map((line) => (line.trim() === "#import site" ? "import site" : line));
  const importSiteIndex = lines.findIndex(
    (line) => line.trim() === "import site",
  );
  if (importSiteIndex === -1) {
    lines.push(normalizedPackageDir, "import site");
  } else {
    lines.splice(importSiteIndex, 0, normalizedPackageDir);
  }
  writeFileSync(
    pthPath,
    `${lines.filter((line, index, array) => index < array.length - 1 || line.trim()).join("\n")}\n`,
    "utf8",
  );
}

module.exports = {
  downloadFile,
  ensureEmbeddedPythonPackagePath,
  extractZipSafely,
  run,
  sanitizeStandaloneEmbeddedPythonPathFile,
};
