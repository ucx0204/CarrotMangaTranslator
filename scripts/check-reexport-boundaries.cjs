// @ts-check
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { extname, join } = require("node:path");
const ts = require("typescript");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * Only deliberate public facades and layer-local adapters may re-export.
 * Both the boundary file and its source module are fixed so an approved
 * facade cannot silently grow into a general-purpose barrel.
 *
 * @type {ReadonlyMap<string, ReadonlySet<string>>}
 */
const APPROVED_REEXPORT_BOUNDARIES = new Map([
  [
    "src/main/appSettings.ts",
    new Set([
      "../shared/modelPresets",
      "./settings/appSettingsDefaults",
      "./settings/appSettingsNormalize",
      "./settings/appSettingsTypes",
      "./settings/hardwareDefaults",
      "./settings/translationOptions",
    ]),
  ],
  ["src/main/gpuInfo.ts", new Set(["./amdRocmTargets", "./gpuInfoTypes"])],
  [
    "src/main/inpainting.ts",
    new Set(["./inpainting/koharuEngine", "./inpainting/patternPage"]),
  ],
  [
    "src/main/inpainting/fluxEngine.ts",
    new Set(["./fluxChangeStats", "./fluxEngineConstants"]),
  ],
  [
    "src/main/library.ts",
    new Set([
      "./library/libraryContextFacade",
      "./library/libraryImportFacade",
      "./library/libraryMutationFacade",
      "./library/libraryReadFacade",
      "./library/libraryShareFacade",
      "./libraryStore/libraryCleanup",
      "./libraryStore/libraryFiles",
      "./libraryStore/libraryPaths",
      "./libraryStore/workTypographyProfileFiles",
    ]),
  ],
  ["src/main/inpainting/localization.ts", new Set(["../i18n"])],
  ["src/main/ipc/localization.ts", new Set(["../i18n"])],
  ["src/main/jobs/localization.ts", new Set(["../i18n"])],
  ["src/main/libraryStore/localization.ts", new Set(["../i18n"])],
  ["src/main/pipeline/localization.ts", new Set(["../i18n"])],
  [
    "src/main/pipeline/fontMatchingDecisionV2.ts",
    new Set(["./fontMatchingDecisionV2Types"]),
  ],
  [
    "src/main/pipeline/automaticFontMatchingV2.ts",
    new Set(["./automaticFontMatchingV2Catalog"]),
  ],
  ["src/main/jobs/inpaintingJobs.ts", new Set(["./inpaintingJobTypes"])],
  ["src/main/jobs/translationJobs.ts", new Set(["./translationJobTypes"])],
  [
    "src/shared/blockTransforms.ts",
    new Set([
      "./blockTransformPresets",
      "./curveTransformMath",
      "./perspectiveTransformMath",
    ]),
  ],
  ["src/shared/ipcSchemaPrimitives.ts", new Set(["./ipcEnumSchemas"])],
  [
    "src/shared/ipcSchemas.ts",
    new Set([
      "./ipcJobSchemas",
      "./ipcLibrarySchemas",
      "./ipcSchemaPrimitives",
      "./ipcSettingsSchemas",
      "./ipcWorkContextSchemas",
    ]),
  ],
  ["src/shared/jobTypes.ts", new Set(["./jobContracts"])],
  [
    "src/shared/settingsTypes.ts",
    new Set([
      "./blockFormat",
      "./codexSettings",
      "./inpaintingSettingsTypes",
      "./translationLanguages",
      "./uiLocales",
    ]),
  ],
  ["src/shared/textWrapping.ts", new Set(["./textTypes"])],
  [
    "src/renderer/src/components/ImageStage.tsx",
    new Set(["./imageStageTypes"]),
  ],
  [
    "src/renderer/src/hooks/useChapterPersistence.ts",
    new Set(["./chapterPersistenceTypes"]),
  ],
  [
    "src/renderer/src/hooks/useInpaintingRetouch.ts",
    new Set(["./inpaintingRetouchTypes"]),
  ],
  [
    "src/renderer/src/hooks/useTranslationActions.ts",
    new Set(["./translationActionTypes"]),
  ],
  [
    "src/renderer/src/lib/blockFormatGeometry.ts",
    new Set(["../../../shared/geometry"]),
  ],
]);

/** @typedef {"unapproved-boundary" | "unapproved-source" | "wildcard"} ReexportRule */
/** @typedef {{ file: string, line: number, rule: ReexportRule, source: string }} ReexportViolation */

/** @param {string} [repoRoot] */
function listSourceFiles(repoRoot = process.cwd()) {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "src",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return output
    .split("\0")
    .map(normalizePath)
    .filter(
      (file) =>
        Boolean(file) &&
        SOURCE_EXTENSIONS.has(extname(file)) &&
        existsSync(join(repoRoot, file)),
    );
}

/**
 * @param {string} file
 * @param {string} sourceText
 * @param {ReadonlyMap<string, ReadonlySet<string>>} [approvedBoundaries]
 * @returns {ReexportViolation[]}
 */
function inspectSource(
  file,
  sourceText,
  approvedBoundaries = APPROVED_REEXPORT_BOUNDARIES,
) {
  const normalizedFile = normalizePath(file);
  const sourceFile = ts.createSourceFile(
    normalizedFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    normalizedFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  /** @type {ReexportViolation[]} */
  const violations = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {
      continue;
    }
    const source = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : statement.moduleSpecifier.getText(sourceFile);
    const line =
      sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
        .line + 1;
    const approvedSources = approvedBoundaries.get(normalizedFile);
    const wildcard =
      !statement.exportClause || ts.isNamespaceExport(statement.exportClause);
    if (wildcard) {
      violations.push({ file: normalizedFile, line, rule: "wildcard", source });
    } else if (!approvedSources) {
      violations.push({
        file: normalizedFile,
        line,
        rule: "unapproved-boundary",
        source,
      });
    } else if (!approvedSources.has(source)) {
      violations.push({
        file: normalizedFile,
        line,
        rule: "unapproved-source",
        source,
      });
    }
  }
  return violations;
}

/** @param {string} [repoRoot] */
function findReexportViolations(repoRoot = process.cwd()) {
  return listSourceFiles(repoRoot).flatMap((file) =>
    inspectSource(file, readFileSync(join(repoRoot, file), "utf8")),
  );
}

/** @param {string} value */
function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function main() {
  const violations = findReexportViolations();
  if (violations.length === 0) {
    console.log("Re-export boundary check passed.");
    return;
  }
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} [${violation.rule}] ${violation.source}`,
    );
  }
  console.error(
    "Import from the owning module directly, or document a deliberate facade source in the boundary allowlist.",
  );
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  APPROVED_REEXPORT_BOUNDARIES,
  findReexportViolations,
  inspectSource,
  listSourceFiles,
};
