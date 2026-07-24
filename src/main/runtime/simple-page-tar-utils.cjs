// @ts-check
const {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} = require("node:fs");
const { chmod, mkdir, rm, symlink } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");

/**
 * app-runtime is copied outside app.asar, so its ordinary CommonJS lookup
 * cannot see production dependencies stored inside app.asar. Development can
 * use the repository node_modules directly; packaged apps retry from the ASAR
 * package root.
 *
 * @typedef {(specifier: string) => unknown} RuntimeRequire
 * @typedef {(filename: string) => RuntimeRequire} PackagedRequireFactory
 *
 * @param {{ moduleRequire?: RuntimeRequire; resourcesPath?: string; createPackagedRequire?: PackagedRequireFactory }} [options]
 */
function loadTarRuntime(options = {}) {
  const moduleRequire = options.moduleRequire ?? require;
  try {
    return moduleRequire("tar");
  } catch (error) {
    const resourcesPath =
      options.resourcesPath ??
      /** @type {NodeJS.Process & { resourcesPath?: string }} */ (process)
        .resourcesPath;
    if (!isMissingDirectTarModule(error) || !resourcesPath) {
      throw error;
    }
    const packagedRequire = (options.createPackagedRequire ?? createRequire)(
      path.join(resourcesPath, "app.asar", "package.json"),
    );
    return packagedRequire("tar");
  }
}

/** @param {unknown} error */
function isMissingDirectTarModule(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "MODULE_NOT_FOUND" &&
    /Cannot find module ['"]tar['"]/.test(error.message)
  );
}

const tar = loadTarRuntime();

/** @typedef {(name: string, relativePath: string) => boolean} RuntimeEntryFilter */
/** @typedef {{ path: string; type?: string; linkpath?: string; size?: number; mode?: number }} TarEntryInfo */

/**
 * Extract a checksum-verified runtime tarball after a complete metadata pass.
 * Entry paths and symlink targets are rejected before anything is written.
 *
 * @param {string} archivePath
 * @param {string} outputDir
 * @param {RuntimeEntryFilter} shouldExtract
 * @param {{ stripComponents?: number }} [options]
 */
async function extractSelectedTarEntries(
  archivePath,
  outputDir,
  shouldExtract,
  options = {},
) {
  const stripComponents = normalizeStripComponents(options.stripComponents);
  const entries = await inspectTarEntries(archivePath);
  validateTarEntries(entries, stripComponents);
  await mkdir(outputDir, { recursive: true });
  await tar.x({
    file: archivePath,
    cwd: outputDir,
    strip: stripComponents,
    preservePaths: false,
    preserveOwner: false,
    strict: true,
    unlink: true,
    /** @param {string} entryPath @param {any} entry */
    filter: (entryPath, entry) => {
      const tarEntry = /** @type {any} */ (entry);
      const entryInfo = {
        path: entryPath,
        type: tarEntry.type,
        linkpath: tarEntry.linkpath,
        size: tarEntry.size,
        mode: tarEntry.mode,
      };
      return (
        !isSymbolicLinkType(entryInfo.type) &&
        shouldExtractTarEntry(entryInfo, stripComponents, shouldExtract)
      );
    },
  });
  await createSelectedTarSymlinks(
    entries,
    outputDir,
    stripComponents,
    shouldExtract,
  );
  assertExtractedSymlinksStayInside(outputDir);
  const serverPath = path.join(outputDir, "llama-server");
  try {
    await chmod(serverPath, 0o755);
  } catch (_error) {
    // error-policy-allow: the caller validates and reports a missing server.
    // The caller reports the missing required binary with runtime details.
  }
}

/** @param {TarEntryInfo[]} entries @param {string} outputDir @param {number} stripComponents @param {RuntimeEntryFilter} shouldExtract */
async function createSelectedTarSymlinks(
  entries,
  outputDir,
  stripComponents,
  shouldExtract,
) {
  for (const entry of entries) {
    if (
      !isSymbolicLinkType(entry.type) ||
      !shouldExtractTarEntry(entry, stripComponents, shouldExtract)
    ) {
      continue;
    }
    const safePath = normalizeSafeArchivePath(entry.path);
    const outputPath = stripArchivePath(safePath, stripComponents);
    const linkPath = path.join(outputDir, outputPath);
    await mkdir(path.dirname(linkPath), { recursive: true });
    await rm(linkPath, { force: true });
    await symlink(String(entry.linkpath), linkPath);
  }
}

/** @param {string} archivePath @returns {Promise<TarEntryInfo[]>} */
async function inspectTarEntries(archivePath) {
  /** @type {TarEntryInfo[]} */
  const entries = [];
  await tar.t({
    file: archivePath,
    strict: true,
    /** @param {any} entry */
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        type: entry.type,
        linkpath: entry.linkpath,
        size: entry.size,
        mode: entry.mode,
      });
    },
  });
  if (entries.length === 0) {
    throw new Error(`${path.basename(archivePath)} archive is empty.`);
  }
  return entries;
}

/** @param {TarEntryInfo[]} entries @param {number} [stripComponents] */
function validateTarEntries(entries, stripComponents = 0) {
  const outputPaths = new Set();
  for (const entry of entries) {
    const archivePath = normalizeSafeArchivePath(entry.path);
    const outputPath = stripArchivePath(archivePath, stripComponents);
    if (!outputPath) continue;
    assertSupportedTarEntryType(entry);
    const foldedOutput = outputPath.toLowerCase();
    if (outputPaths.has(foldedOutput) && !isDirectoryType(entry.type)) {
      throw new Error(
        `Runtime tar archive contains duplicate output: ${outputPath}`,
      );
    }
    outputPaths.add(foldedOutput);
    if (isSymbolicLinkType(entry.type)) {
      validateSymlinkTarget(outputPath, entry.linkpath);
    }
  }
}

/** @param {TarEntryInfo} entry */
function assertSupportedTarEntryType(entry) {
  const type = String(entry.type || "File");
  if (
    ["File", "OldFile", "ContiguousFile", "Directory", "SymbolicLink"].includes(
      type,
    )
  ) {
    return;
  }
  throw new Error(
    `Runtime tar archive contains unsupported ${type} entry: ${entry.path}`,
  );
}

/** @param {string} rawPath */
function normalizeSafeArchivePath(rawPath) {
  const value = String(rawPath || "").replace(/\\/g, "/");
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new Error(`Runtime tar archive contains an unsafe path: ${rawPath}`);
  }
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Runtime tar archive contains an unsafe path: ${rawPath}`);
  }
  return parts.join("/");
}

/** @param {string} safePath @param {number} stripComponents */
function stripArchivePath(safePath, stripComponents) {
  return safePath.split("/").slice(stripComponents).join("/");
}

/** @param {string} outputPath @param {unknown} rawTarget */
function validateSymlinkTarget(outputPath, rawTarget) {
  const target = String(rawTarget || "").replace(/\\/g, "/");
  if (
    !target ||
    target.includes("\0") ||
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[a-zA-Z]:/.test(target)
  ) {
    throw new Error(
      `Runtime tar archive contains an unsafe symlink: ${outputPath}`,
    );
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(outputPath), target),
  );
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(
      `Runtime tar archive symlink escapes extraction root: ${outputPath} -> ${target}`,
    );
  }
}

/** @param {TarEntryInfo} entry @param {number} stripComponents @param {RuntimeEntryFilter} shouldExtract */
function shouldExtractTarEntry(entry, stripComponents, shouldExtract) {
  const safePath = normalizeSafeArchivePath(entry.path);
  const outputPath = stripArchivePath(safePath, stripComponents);
  if (!outputPath) return false;
  if (isDirectoryType(entry.type)) return true;
  if (!isRegularOrSymbolicLink(entry.type)) return false;
  return shouldExtract(path.posix.basename(outputPath), outputPath);
}

/** @param {unknown} type */
function isDirectoryType(type) {
  return String(type || "") === "Directory";
}

/** @param {unknown} type */
function isSymbolicLinkType(type) {
  return String(type || "") === "SymbolicLink";
}

/** @param {unknown} type */
function isRegularOrSymbolicLink(type) {
  return ["File", "OldFile", "ContiguousFile", "SymbolicLink"].includes(
    String(type || "File"),
  );
}

/** @param {string} rootDir */
function assertExtractedSymlinksStayInside(rootDir) {
  const root = path.resolve(rootDir);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      inspectExtractedEntry(entryPath, root, stack);
    }
  }
}

/** @param {string} entryPath @param {string} root @param {string[]} stack */
function inspectExtractedEntry(entryPath, root, stack) {
  const stat = lstatSync(entryPath);
  if (stat.isDirectory()) {
    stack.push(entryPath);
    return;
  }
  if (stat.isSymbolicLink()) assertSafeExtractedSymlink(entryPath, root);
}

/** @param {string} entryPath @param {string} root */
function assertSafeExtractedSymlink(entryPath, root) {
  const target = readlinkSync(entryPath);
  const resolved = path.resolve(path.dirname(entryPath), target);
  const realRoot = realpathSync(root);
  let realResolved;
  try {
    realResolved = realpathSync(entryPath);
  } catch (cause) {
    throw new Error(`Extracted runtime symlink is broken: ${entryPath}`, {
      cause,
    });
  }
  if (!isPathInside(resolved, root) || !isPathInside(realResolved, realRoot)) {
    throw new Error(
      `Extracted runtime symlink escapes extraction root: ${entryPath}`,
    );
  }
}

/** @param {string} childPath @param {string} parentPath */
function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** @param {unknown} value */
function normalizeStripComponents(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

module.exports = {
  extractSelectedTarEntries,
  loadTarRuntime,
  normalizeSafeArchivePath,
  validateSymlinkTarget,
  validateTarEntries,
};
