const {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { dirname, extname, join, relative, resolve } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const sourceRoot = join(projectRoot, "src");
const rendererRoot = join(sourceRoot, "renderer", "src");
const baselinePath = join(__dirname, "maintainability-policy-baseline.json");

/**
 * @typedef {"button" | "input" | "select" | "textarea"} RawControlName
 * @typedef {Record<RawControlName, number>} RawControlCounts
 * @typedef {{ literalColors: number; numericZIndexes: number }} CssLiteralCounts
 * @typedef {{
 *   fileWideLintDisables: Record<string, string>;
 *   rawFeatureControls: Record<string, RawControlCounts>;
 *   rendererCssLiterals: Record<string, CssLiteralCounts>;
 *   crossPrimitiveStyleImports: Record<string, string[]>;
 * }} PolicySnapshot
 */

const literalColorExemptions = new Map([
  [
    "src/renderer/src/styles/foundations.css",
    "semantic design-token authority",
  ],
  [
    "src/renderer/src/pageExport/styles.css",
    "exported artwork colours are output data, not application chrome",
  ],
]);

const allowedGlobalStyleImports = new Map([
  ["src/renderer/src/App.tsx", ["src/renderer/src/styles.css"]],
  ["src/renderer/src/AppSession.tsx", ["src/renderer/src/styles.css"]],
  [
    "src/renderer/src/components/ErrorReportWindowApp.tsx",
    ["src/renderer/src/styles.css"],
  ],
  [
    "src/renderer/src/components/PageArtwork.tsx",
    ["src/renderer/src/components/overlayTransforms.css"],
  ],
  [
    "src/renderer/src/components/WarpEditorControls.tsx",
    ["src/renderer/src/components/warpEditorControls.css"],
  ],
  [
    "src/renderer/src/pageExport/browserEntry.tsx",
    ["src/renderer/src/pageExport/styles.css"],
  ],
  [
    "src/renderer/src/panels/PanelWindowApp.tsx",
    ["src/renderer/src/styles.css"],
  ],
]);

/** @param {string} path */
function toProjectPath(path) {
  return relative(projectRoot, path).replaceAll("\\", "/");
}

/** @param {string} directory @returns {string[]} */
function walkFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

/** @param {string} source */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** @param {string} source */
function readFileWideLintDisable(source) {
  const match = /^\uFEFF?\s*\/\*\s*eslint-disable\b([^*]*)\*\//.exec(source);
  if (!match) return undefined;
  const rules = match[1]
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean)
    .sort();
  return rules.length > 0 ? rules.join(", ") : "all rules";
}

/** @param {string} source */
function countRawControls(source) {
  /** @type {RawControlCounts} */
  const controls = { button: 0, input: 0, select: 0, textarea: 0 };
  for (const match of source.matchAll(/<(button|input|select|textarea)\b/g)) {
    const name = /** @type {RawControlName} */ (match[1]);
    controls[name] += 1;
  }
  return controls;
}

/** @param {Record<string, number>} counts */
function hasCounts(counts) {
  return Object.values(counts).some((count) => count > 0);
}

/** @param {string} source */
function countCssPolicyLiterals(source) {
  const withoutComments = stripComments(source);
  return {
    literalColors: [
      ...withoutComments.matchAll(
        /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/gi,
      ),
    ].length,
    numericZIndexes: [...withoutComments.matchAll(/\bz-index\s*:\s*-?\d+\b/gi)]
      .length,
  };
}

/** @param {string} sourcePath @param {string} specifier */
function resolveStyleImport(sourcePath, specifier) {
  return toProjectPath(resolve(dirname(sourcePath), specifier));
}

/** @param {string} sourcePath @param {string} source */
function readStyleImports(sourcePath, source) {
  const imports = [];
  for (const match of source.matchAll(
    /\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+\.css)["']/g,
  )) {
    imports.push({
      module: match[1],
      resolved: resolveStyleImport(sourcePath, match[1]),
    });
  }
  return imports;
}

/** @param {string} projectPath */
function isUiPrimitivePath(projectPath) {
  return projectPath.startsWith("src/renderer/src/components/ui/");
}

/**
 * @param {string} projectPath
 * @param {string} extension
 * @param {string} source
 * @param {PolicySnapshot} snapshot
 */
function inspectRawFeatureControls(projectPath, extension, source, snapshot) {
  if (extension !== ".tsx") return;
  if (isUiPrimitivePath(projectPath)) return;
  if (/\.(?:test|spec)\.tsx$/.test(projectPath)) return;
  const controls = countRawControls(source);
  if (hasCounts(controls)) snapshot.rawFeatureControls[projectPath] = controls;
}

/**
 * @param {string} projectPath
 * @param {{ module: string; resolved: string }} styleImport
 * @param {PolicySnapshot} snapshot
 * @param {string[]} forbiddenGlobalStyleImports
 */
function inspectStyleImport(
  projectPath,
  styleImport,
  snapshot,
  forbiddenGlobalStyleImports,
) {
  if (styleImport.module.endsWith(".module.css")) {
    const importsPrimitiveStyle = styleImport.resolved.startsWith(
      "src/renderer/src/components/ui/",
    );
    if (!importsPrimitiveStyle || isUiPrimitivePath(projectPath)) return;
    snapshot.crossPrimitiveStyleImports[projectPath] ??= [];
    snapshot.crossPrimitiveStyleImports[projectPath].push(styleImport.resolved);
    return;
  }

  const allowed = allowedGlobalStyleImports.get(projectPath) ?? [];
  if (allowed.includes(styleImport.resolved)) return;
  forbiddenGlobalStyleImports.push(
    `${projectPath} imports global stylesheet ${styleImport.resolved}`,
  );
}

/**
 * @param {string} path
 * @param {string} projectPath
 * @param {string} extension
 * @param {PolicySnapshot} snapshot
 * @param {string[]} forbiddenGlobalStyleImports
 */
function inspectScriptFile(
  path,
  projectPath,
  extension,
  snapshot,
  forbiddenGlobalStyleImports,
) {
  const source = readFileSync(path, "utf8");
  const disable = readFileWideLintDisable(source);
  if (disable) snapshot.fileWideLintDisables[projectPath] = disable;
  if (!path.startsWith(rendererRoot)) return;
  inspectRawFeatureControls(projectPath, extension, source, snapshot);
  for (const styleImport of readStyleImports(path, source)) {
    inspectStyleImport(
      projectPath,
      styleImport,
      snapshot,
      forbiddenGlobalStyleImports,
    );
  }
}

/** @param {string} path @param {string} projectPath @param {PolicySnapshot} snapshot */
function inspectRendererCssFile(path, projectPath, snapshot) {
  const counts = countCssPolicyLiterals(readFileSync(path, "utf8"));
  if (literalColorExemptions.has(projectPath)) counts.literalColors = 0;
  if (hasCounts(counts)) snapshot.rendererCssLiterals[projectPath] = counts;
}

function collectPolicySnapshot() {
  /** @type {PolicySnapshot} */
  const snapshot = {
    fileWideLintDisables: {},
    rawFeatureControls: {},
    rendererCssLiterals: {},
    crossPrimitiveStyleImports: {},
  };
  /** @type {string[]} */
  const forbiddenGlobalStyleImports = [];

  for (const path of walkFiles(sourceRoot)) {
    const projectPath = toProjectPath(path);
    const extension = extname(path);
    const isScript = [".cjs", ".js", ".jsx", ".ts", ".tsx"].includes(extension);
    if (isScript)
      inspectScriptFile(
        path,
        projectPath,
        extension,
        snapshot,
        forbiddenGlobalStyleImports,
      );
    if (extension === ".css" && path.startsWith(rendererRoot))
      inspectRendererCssFile(path, projectPath, snapshot);
  }

  for (const imports of Object.values(snapshot.crossPrimitiveStyleImports)) {
    imports.sort();
  }
  return { forbiddenGlobalStyleImports, snapshot: sortRecord(snapshot) };
}

/** @template T @param {T} value @returns {T} */
function sortRecord(value) {
  if (Array.isArray(value)) {
    return /** @type {T} */ (value.map(sortRecord));
  }
  if (!value || typeof value !== "object") return value;
  return /** @type {T} */ (
    Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortRecord(nested)]),
    )
  );
}

/** @param {string} label @param {Record<string, unknown>} expected @param {Record<string, unknown>} actual */
function compareSnapshotSection(label, expected, actual) {
  const violations = [];
  const expectedRecord = expected ?? {};
  const actualRecord = actual ?? {};
  for (const key of new Set([
    ...Object.keys(expectedRecord),
    ...Object.keys(actualRecord),
  ])) {
    const before = JSON.stringify(expectedRecord[key]);
    const now = JSON.stringify(actualRecord[key]);
    if (before !== now) {
      violations.push(
        `${label} changed for ${key} (baseline ${before ?? "absent"}, current ${now ?? "absent"}); remove debt or update the baseline in the same reviewed change`,
      );
    }
  }
  return violations;
}

/** @param {Record<string, Record<string, number>>} record */
function sumNestedCounts(record) {
  return Object.values(record).reduce(
    (total, counts) =>
      total + Object.values(counts).reduce((sum, count) => sum + count, 0),
    0,
  );
}

/** @param {PolicySnapshot} snapshot @param {string[]} forbiddenGlobalStyleImports */
function updateBaseline(snapshot, forbiddenGlobalStyleImports) {
  if (forbiddenGlobalStyleImports.length > 0) {
    process.stderr.write(
      `Refusing to update the policy baseline while forbidden global CSS imports exist:\n${forbiddenGlobalStyleImports.map((item) => `- ${item}`).join("\n")}\n`,
    );
    return false;
  }
  const baseline = { version: 1, ...snapshot };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  process.stdout.write(`Updated ${toProjectPath(baselinePath)}.\n`);
  return true;
}

function runPolicyCheck() {
  const { forbiddenGlobalStyleImports, snapshot } = collectPolicySnapshot();
  if (process.argv.slice(2).includes("--update-baseline")) {
    return updateBaseline(snapshot, forbiddenGlobalStyleImports);
  }
  if (!existsSync(baselinePath)) {
    process.stderr.write(
      `Missing ${toProjectPath(baselinePath)}; create it with --update-baseline after reviewing the inventory.\n`,
    );
    return false;
  }

  const baseline = /** @type {PolicySnapshot} */ (
    JSON.parse(readFileSync(baselinePath, "utf8"))
  );
  const violations = [...forbiddenGlobalStyleImports];
  /** @type {(keyof PolicySnapshot)[]} */
  const sections = [
    "fileWideLintDisables",
    "rawFeatureControls",
    "rendererCssLiterals",
    "crossPrimitiveStyleImports",
  ];
  for (const section of sections) {
    violations.push(
      ...compareSnapshotSection(section, baseline[section], snapshot[section]),
    );
  }
  if (violations.length > 0) {
    process.stderr.write(
      `Maintainability policy check failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`,
    );
    return false;
  }

  const rawControls = sumNestedCounts(snapshot.rawFeatureControls);
  const cssLiterals = sumNestedCounts(snapshot.rendererCssLiterals);
  const styleLeaks = Object.values(snapshot.crossPrimitiveStyleImports).reduce(
    (total, imports) => total + imports.length,
    0,
  );
  process.stdout.write(
    `Maintainability policy passed (${Object.keys(snapshot.fileWideLintDisables).length} lint-disable files, ${rawControls} raw feature controls, ${cssLiterals} CSS literal/z-index occurrences, ${styleLeaks} primitive style leaks; no increases).\n`,
  );
  return true;
}

module.exports = {
  collectPolicySnapshot,
  countCssPolicyLiterals,
  countRawControls,
  readFileWideLintDisable,
  runPolicyCheck,
};

if (require.main === module && !runPolicyCheck()) {
  process.exitCode = 1;
}
