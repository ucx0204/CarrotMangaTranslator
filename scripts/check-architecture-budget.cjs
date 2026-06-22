const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const baseline = JSON.parse(
  readFileSync(join(__dirname, "architecture-budget-baseline.json"), "utf8"),
);
const depcruiseBin = join(
  process.cwd(),
  "node_modules",
  "dependency-cruiser",
  "bin",
  "dependency-cruise.mjs",
);

/**
 * @typedef {{ coreModule?: boolean; couldNotResolve?: boolean }} DepcruiseDependency
 * @typedef {{ source: string; dependencies?: DepcruiseDependency[]; dependents?: unknown[] }} DepcruiseModule
 */

function readDepcruiseReport() {
  return execFileSync(
    process.execPath,
    [
      depcruiseBin,
      "--config",
      ".dependency-cruiser.cjs",
      "--include-only",
      "^src",
      "--output-type",
      "json",
      "src",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

/** @type {{ modules?: DepcruiseModule[] }} */
const report = JSON.parse(readDepcruiseReport());
const violations = [];

for (const moduleInfo of report.modules ?? []) {
  const source = moduleInfo.source;
  const allow = baseline.allow?.[source] ?? {};
  const maxImports = allow.maxImports ?? baseline.defaultMaxImports;
  const maxImportedBy = allow.maxImportedBy ?? baseline.defaultMaxImportedBy;
  const imports = (moduleInfo.dependencies ?? []).filter(
    (dependency) => !dependency.coreModule && !dependency.couldNotResolve,
  ).length;
  const importedBy = (moduleInfo.dependents ?? []).length;

  if (imports > maxImports) {
    violations.push(
      `${source}: imports ${imports} exceeds budget ${maxImports}`,
    );
  }
  if (importedBy > maxImportedBy) {
    violations.push(
      `${source}: importedBy ${importedBy} exceeds budget ${maxImportedBy}`,
    );
  }
}

if (violations.length > 0) {
  console.error("Architecture budget failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("architecture budget passed");
