const { readFileSync } = require("node:fs");
const { dirname, relative, resolve } = require("node:path");

/**
 * @typedef {{
 *   fontId: string;
 *   label: string;
 *   cssFamily: string;
 * }} KoreanCatalogEntry
 */

/**
 * @typedef {{
 *   cssFamily: string;
 *   sourcePath: string;
 *   format: string;
 *   weight: { raw: string; min: number; max: number };
 *   style: string;
 *   sourceOrder: number;
 * }} CssFontFace
 */

/**
 * Reads the Korean portion of the production font catalog without maintaining
 * a second list of font IDs. The catalog is TypeScript, but every definition is
 * intentionally data-shaped and can be audited from source.
 *
 * @param {string} catalogPath
 * @returns {KoreanCatalogEntry[]}
 */
function readKoreanCatalog(catalogPath) {
  const source = readFileSync(catalogPath, "utf8");
  const sectionMatch = /\/\/ Korean([\s\S]*?)\/\/ English/.exec(source);
  if (!sectionMatch) {
    throw new Error("Could not locate the Korean catalog section.");
  }

  const entries = [];
  const entryPattern =
    /\{\s*id:\s*"([^"]+)",\s*locale:\s*"ko",\s*label:\s*"([^"]+)",\s*cssFamily:\s*fontFamily\(\s*"([^"]+)"/g;
  for (const match of sectionMatch[1].matchAll(entryPattern)) {
    entries.push({
      fontId: match[1],
      label: match[2],
      cssFamily: match[3],
    });
  }

  if (entries.length !== 21) {
    throw new Error(
      `Expected 21 Korean catalog entries, found ${entries.length}.`,
    );
  }
  assertUnique(
    entries.map((entry) => entry.fontId),
    "Korean font ID",
  );
  assertUnique(
    entries.map((entry) => entry.cssFamily),
    "Korean CSS family",
  );
  return entries;
}

/**
 * @param {string} cssPath
 * @returns {CssFontFace[]}
 */
function readCssFontFaces(cssPath) {
  const source = readFileSync(cssPath, "utf8");
  const faces = [];
  let sourceOrder = 0;
  for (const blockMatch of source.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const block = blockMatch[1];
    const family = requireMatch(block, /font-family:\s*"([^"]+)"/, "family");
    const sourcePath = requireMatch(
      block,
      /src:\s*url\("([^"]+)"\)\s*format\("([^"]+)"\)/s,
      "source URL",
    );
    const formatMatch = /src:\s*url\("([^"]+)"\)\s*format\("([^"]+)"\)/s.exec(
      block,
    );
    const rawWeight = requireMatch(
      block,
      /font-weight:\s*([^;]+);/,
      "weight",
    ).trim();
    const style = requireMatch(block, /font-style:\s*([^;]+);/, "style").trim();
    const weight = parseCssWeight(rawWeight);
    faces.push({
      cssFamily: family,
      sourcePath: resolve(dirname(cssPath), sourcePath),
      format: formatMatch?.[2] ?? "unknown",
      weight,
      style,
      sourceOrder,
    });
    sourceOrder += 1;
  }
  return faces;
}

/**
 * @param {string} raw
 * @returns {{ raw: string; min: number; max: number }}
 */
function parseCssWeight(raw) {
  const parts = raw.split(/\s+/).map(Number);
  if (
    (parts.length !== 1 && parts.length !== 2) ||
    parts.some((value) => !Number.isInteger(value) || value < 1 || value > 1000)
  ) {
    throw new Error(`Unsupported CSS font weight declaration: ${raw}`);
  }
  return {
    raw,
    min: parts[0],
    max: parts[1] ?? parts[0],
  };
}

/**
 * @param {string} source
 * @param {RegExp} pattern
 * @param {string} field
 */
function requireMatch(source, pattern, field) {
  const match = pattern.exec(source);
  if (!match?.[1]) {
    throw new Error(`A @font-face block is missing its ${field}.`);
  }
  return match[1];
}

/**
 * @param {string[]} values
 * @param {string} label
 */
function assertUnique(values, label) {
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(`${label} values must be unique.`);
  }
}

/** @param {string} root @param {string} path */
function toRepoPath(root, path) {
  const output = relative(root, path).replace(/\\/g, "/");
  if (output === ".." || output.startsWith("../")) {
    throw new Error(`Font asset escapes the repository: ${path}`);
  }
  return output;
}

module.exports = {
  readCssFontFaces,
  readKoreanCatalog,
  toRepoPath,
};
