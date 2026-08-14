const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const ROOT_SCRIPT_PATTERN = /\.(?:cjs|mjs)$/u;

/**
 * @typedef {{
 *   path: string;
 *   status: string;
 *   purpose: string;
 *   usage: string;
 *   replacement: string;
 * }} ManualScriptEntry
 * @typedef {{ schemaVersion: 1; entries: ManualScriptEntry[] }} ManualScriptManifest
 * @typedef {{ scripts?: Record<string, string> }} PackageJson
 * @typedef {{
 *   entries: string[];
 *   manualEntries: ManualScriptEntry[];
 *   orphans: string[];
 * }} ScriptEntrypointInventory
 */

/** @param {string} repoRoot @returns {ScriptEntrypointInventory} */
function buildScriptEntrypointInventory(repoRoot) {
  const scriptsRoot = join(repoRoot, "scripts");
  const rootScripts = readdirSync(scriptsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ROOT_SCRIPT_PATTERN.test(entry.name))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
  /** @type {PackageJson} */
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  const manifest = readManualEntrypoints(repoRoot);
  const workflowText = readDirectoryText(
    join(repoRoot, ".github", "workflows"),
  );
  const packageScriptText = Object.values(packageJson.scripts ?? {}).join("\n");
  const projectReferenceText = ["src", "tests", "scripts"]
    .map((directory) =>
      readProjectReferenceText(join(repoRoot, directory), scriptsRoot),
    )
    .join("\n");
  const seedText = `${packageScriptText}\n${workflowText}\n${projectReferenceText}`;
  const manualPaths = new Set(manifest.entries.map((entry) => entry.path));
  const rootSet = new Set(rootScripts);

  for (const entry of manifest.entries) {
    validateManualEntry(entry, rootSet);
  }

  const roots = rootScripts.filter(
    (path) => mentionsScript(seedText, path) || manualPaths.has(path),
  );
  const references = new Map(
    rootScripts.map((path) => {
      const text = readFileSync(join(repoRoot, path), "utf8");
      return [
        path,
        rootScripts.filter(
          (candidate) => candidate !== path && mentionsScript(text, candidate),
        ),
      ];
    }),
  );
  const reachable = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) continue;
    for (const reference of references.get(path) ?? []) {
      if (reachable.has(reference)) continue;
      reachable.add(reference);
      queue.push(reference);
    }
  }

  return {
    entries: [...reachable].sort(),
    manualEntries: manifest.entries,
    orphans: rootScripts.filter((path) => !reachable.has(path)),
  };
}

/** @param {string} repoRoot @returns {ManualScriptManifest} */
function readManualEntrypoints(repoRoot) {
  const path = join(repoRoot, "scripts", "manual-entrypoints.json");
  /** @type {unknown} */
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isManualEntry) ||
    value.entries.length !==
      new Set(value.entries.map((entry) => entry.path)).size
  ) {
    throw new Error(
      "scripts/manual-entrypoints.json is invalid or contains duplicate paths.",
    );
  }
  return /** @type {ManualScriptManifest} */ (value);
}

/** @param {ManualScriptEntry} entry @param {Set<string>} rootScripts */
function validateManualEntry(entry, rootScripts) {
  if (!rootScripts.has(entry.path)) {
    throw new Error(
      `Manual script entry does not exist at the script root: ${entry.path}`,
    );
  }
}

/** @param {string} text @param {string} scriptPath */
function mentionsScript(text, scriptPath) {
  const fileName = scriptPath.slice("scripts/".length);
  return text.includes(scriptPath) || text.includes(fileName);
}

/** @param {string} directory @returns {string} */
function readDirectoryText(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(directory, entry.name), "utf8"))
      .join("\n");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return "";
    throw error;
  }
}

/** @param {string} directory @param {string} rootScriptsDirectory @returns {string} */
function readProjectReferenceText(directory, rootScriptsDirectory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return readProjectReferenceText(path, rootScriptsDirectory);
      }
      if (!entry.isFile()) return [];
      if (
        directory === rootScriptsDirectory &&
        ROOT_SCRIPT_PATTERN.test(entry.name)
      ) {
        return [];
      }
      return /\.(?:cjs|js|json|mjs|ps1|py|ts|tsx|yaml|yml)$/u.test(entry.name)
        ? [readFileSync(path, "utf8")]
        : [];
    })
    .join("\n");
}

/** @param {unknown} value @returns {value is ManualScriptEntry} */
function isManualEntry(value) {
  return (
    isRecord(value) &&
    ["path", "status", "purpose", "usage", "replacement"].every(
      (key) => typeof value[key] === "string" && value[key].trim().length > 0,
    )
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} error @returns {string | undefined} */
function readErrorCode(error) {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

module.exports = { buildScriptEntrypointInventory };
