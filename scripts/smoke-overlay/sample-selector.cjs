const { readFile, readdir } = require("node:fs/promises");
const path = require("node:path");

/**
 * @typedef {{ filePath: string; groupKey: string; hash: number }} SmokeSample
 * @typedef {{ root: string; count: number; targetImagePath: string; targetImageList: string; targetImageListFile: string; sampleOffset: number }} SelectionOptions
 */

/** @param {SelectionOptions} options @returns {Promise<SmokeSample[]>} */
async function selectSmokeSamples(options) {
  const targets = await resolveExplicitTargets(options);
  if (targets.length > 0) {
    return targets.map((filePath) => toSample(options.root, filePath));
  }
  const files = await collectImageFiles(options.root);
  const sorted = rotateItems(
    files
      .map((filePath) => toSample(options.root, filePath))
      .sort((a, b) => a.hash - b.hash || a.filePath.localeCompare(b.filePath)),
    options.sampleOffset,
  );
  return selectAcrossGroups(sorted, options.count);
}

/** @param {SelectionOptions} options */
async function resolveExplicitTargets(options) {
  const fileContents = options.targetImageListFile
    ? await readOptionalText(options.targetImageListFile)
    : "";
  const list = parseTargetImageList(options.targetImageList || fileContents);
  if (list.length > 0) return list;
  return options.targetImagePath ? [options.targetImagePath] : [];
}

/** @param {string} root @param {string} filePath @returns {SmokeSample} */
function toSample(root, filePath) {
  return {
    filePath,
    groupKey: resolveGroupKey(root, filePath),
    hash: stableHash(filePath),
  };
}

/** @param {SmokeSample[]} sorted @param {number} count */
function selectAcrossGroups(sorted, count) {
  /** @type {SmokeSample[]} */
  const selected = [];
  const usedGroups = new Set();
  for (const sample of sorted) {
    if (selected.length >= count) break;
    if (usedGroups.has(sample.groupKey)) continue;
    selected.push(sample);
    usedGroups.add(sample.groupKey);
  }
  for (const sample of sorted) {
    if (selected.length >= count) break;
    if (!selected.some((current) => current.filePath === sample.filePath)) {
      selected.push(sample);
    }
  }
  return selected.slice(0, count);
}

/** @param {unknown} value */
function parseTargetImageList(value) {
  const text = String(value || "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return [];
  const jsonList = parseJsonList(text);
  return jsonList ?? parseDelimitedList(text);
}

/** @param {string} text @returns {string[] | null} */
function parseJsonList(text) {
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry || "").trim()).filter(Boolean)
      : null;
  } catch (error) {
    void error;
    return null;
  }
}

/** @param {string} text */
function parseDelimitedList(text) {
  return text
    .split(/\r?\n|;/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** @param {string} filePath */
async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return "";
    throw new Error(`Could not read smoke image list: ${filePath}`, {
      cause: error,
    });
  }
}

/** @param {unknown} error */
function isMissingFileError(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    /** @type {{ code?: unknown }} */ (error).code === "ENOENT"
  );
}

/** @template T @param {T[]} items @param {number} offset */
function rotateItems(items, offset) {
  if (items.length === 0) return items;
  const normalizedOffset =
    ((offset % items.length) + items.length) % items.length;
  return [
    ...items.slice(normalizedOffset),
    ...items.slice(0, normalizedOffset),
  ];
}

/** @param {string} root */
async function collectImageFiles(root) {
  /** @type {string[]} */
  const result = [];
  /** @type {string[]} */
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of await readDirectory(dir)) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (isCandidateEntry(root, fullPath, entry)) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

/** @param {string} directory */
async function readDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new Error(`Could not inspect smoke image directory: ${directory}`, {
      cause: error,
    });
  }
}

/**
 * @param {string} root
 * @param {string} fullPath
 * @param {import("node:fs").Dirent} entry
 */
function isCandidateEntry(root, fullPath, entry) {
  const extensions = new Set([".jpg", ".jpeg", ".png"]);
  return (
    entry.isFile() &&
    extensions.has(path.extname(entry.name).toLowerCase()) &&
    isOriginalMangaPageCandidate(root, fullPath)
  );
}

/** @param {string} root @param {string} filePath */
function isOriginalMangaPageCandidate(root, filePath) {
  const relativeParts = path
    .relative(root, filePath)
    .split(path.sep)
    .map((part) => part.toLowerCase());
  const blockedSegments = new Set([
    "mask",
    "masks",
    "inpaint",
    "inpainted",
    "translated",
    "translated_images",
    "translation",
    "translations",
    "output",
    "outputs",
    "result",
    "results",
  ]);
  if (relativeParts.some((part) => blockedSegments.has(part))) return false;
  return !/(^|[_\-. ])translated([_\-. ]|$)|(^|[_\-. ])mask([_\-. ]|$)|(^|[_\-. ])inpaint/i.test(
    path.basename(filePath).toLowerCase(),
  );
}

/** @param {string} root @param {string} filePath */
function resolveGroupKey(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep);
  return relative.slice(0, Math.min(3, relative.length - 1)).join("/");
}

/** @param {string} value */
function stableHash(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

module.exports = {
  parseTargetImageList,
  selectSmokeSamples,
};
