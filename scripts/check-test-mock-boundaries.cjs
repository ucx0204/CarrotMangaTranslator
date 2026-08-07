// @ts-check
const { existsSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { extname, join, relative } = require("node:path");
const ts = require("typescript");

const INTERNAL_MODULE_PATTERN = /^(?:\.\.\/)+src\//;
const TEST_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/**
 * These adapters are the actual process/environment boundaries exercised by
 * the listed tests. Keep entries file-specific so feature modules cannot start
 * mocking the same internal adapter by convention.
 */
const ALLOWED_INTERNAL_BOUNDARY_MOCKS = new Set([
  "tests/bubbleOnnxRuntime.test.ts::../src/main/runtimeSupport/modelDownloads",
  "tests/fontMatchingRuntimeAssets.test.ts::../src/main/runtimeSupport/modelDownloads",
  "tests/bubbleLayoutFacade.test.ts::../src/main/bubbleLayout/assets",
  "tests/bubbleLayoutFacade.test.ts::../src/main/bubbleLayout/detector",
  "tests/bubbleLayoutFacade.test.ts::../src/main/logger",
  "tests/fontMatchingPagePixelInference.test.ts::../src/main/logger",
  "tests/inpaintingArtifactCleanup.test.ts::../src/main/appPaths",
  "tests/inpaintingRevisionStore.test.ts::../src/main/appPaths",
  "tests/importOperationLifecycle.test.ts::../src/main/appPaths",
  "tests/libraryImportLimits.test.ts::../src/main/appPaths",
  "tests/libraryPaths.test.ts::../src/main/appPaths",
  "tests/libraryStartupLoad.test.ts::../src/main/appPaths",
  "tests/reviewTable.test.ts::../src/main/appPaths",
  "tests/shareImportCancellation.test.ts::../src/main/appPaths",
  "tests/workContextFiles.test.ts::../src/main/appPaths",
  "tests/workShare.test.ts::../src/main/appPaths",
  "tests/workTypographyProfile.test.ts::../src/main/appPaths",
]);

/** @typedef {{ file: string, line: number, moduleName: string }} MockBoundaryViolation */

/** @param {string} value */
function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

/** @param {string} file @param {string} moduleName */
function isAllowedInternalBoundaryMock(file, moduleName) {
  return ALLOWED_INTERNAL_BOUNDARY_MOCKS.has(
    `${normalizePath(file)}::${moduleName}`,
  );
}

/** @param {import("typescript").CallExpression} node */
function getVitestMockModuleName(node) {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "vi" ||
    !["mock", "doMock"].includes(node.expression.name.text)
  ) {
    return null;
  }
  const moduleArgument = node.arguments[0];
  return moduleArgument && ts.isStringLiteralLike(moduleArgument)
    ? moduleArgument.text
    : null;
}

/**
 * @param {string} file
 * @param {string} sourceText
 * @returns {MockBoundaryViolation[]}
 */
function inspectSource(file, sourceText) {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  /** @type {MockBoundaryViolation[]} */
  const violations = [];

  /** @param {import("typescript").Node} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const moduleName = getVitestMockModuleName(node);
      if (
        moduleName &&
        INTERNAL_MODULE_PATTERN.test(moduleName) &&
        !isAllowedInternalBoundaryMock(file, moduleName)
      ) {
        const location = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: normalizePath(file),
          line: location.line + 1,
          moduleName,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/** @param {string} [repoRoot] */
function listTestFiles(repoRoot = process.cwd()) {
  return execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "tests",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (file) =>
        Boolean(file) &&
        normalizePath(file).startsWith("tests/") &&
        TEST_EXTENSIONS.has(extname(file)),
    );
}

/** @param {string} [repoRoot] @returns {MockBoundaryViolation[]} */
function collectViolations(repoRoot = process.cwd()) {
  const violations = [];
  for (const file of listTestFiles(repoRoot)) {
    const absolutePath = join(repoRoot, file);
    if (!existsSync(absolutePath)) {
      continue;
    }
    violations.push(
      ...inspectSource(
        normalizePath(relative(repoRoot, absolutePath)),
        readFileSync(absolutePath, "utf8"),
      ),
    );
  }
  return violations;
}

/** @param {string} [repoRoot] */
function runMockBoundaryCheck(repoRoot = process.cwd()) {
  const violations = collectViolations(repoRoot);
  if (violations.length === 0) {
    console.log("test mock boundary policy passed");
    return true;
  }
  console.error("Test mock boundary policy failed:");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} mocks internal module ${violation.moduleName}`,
    );
  }
  return false;
}

module.exports = {
  collectViolations,
  inspectSource,
  isAllowedInternalBoundaryMock,
  listTestFiles,
  runMockBoundaryCheck,
};

if (require.main === module && !runMockBoundaryCheck()) {
  process.exitCode = 1;
}
