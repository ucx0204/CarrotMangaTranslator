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
 * @typedef {{ coreModule?: boolean; couldNotResolve?: boolean; dependencyTypes?: string[]; resolved?: string }} DepcruiseDependency
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
/** @type {Record<string, number>} */
const runtimeDependentCounts = {};

for (const moduleInfo of report.modules ?? []) {
  for (const dependency of moduleInfo.dependencies ?? []) {
    if (
      dependency.coreModule ||
      dependency.couldNotResolve ||
      dependency.dependencyTypes?.includes("type-only") ||
      !dependency.resolved
    ) {
      continue;
    }
    runtimeDependentCounts[dependency.resolved] =
      (runtimeDependentCounts[dependency.resolved] ?? 0) + 1;
  }
}

for (const moduleInfo of report.modules ?? []) {
  const source = moduleInfo.source;
  const allow = baseline.allow?.[source] ?? {};
  const maxImports = allow.maxImports ?? baseline.defaultMaxImports;
  const maxImportedBy = allow.maxImportedBy ?? baseline.defaultMaxImportedBy;
  const imports = (moduleInfo.dependencies ?? []).filter(
    (dependency) => !dependency.coreModule && !dependency.couldNotResolve,
  ).length;
  const runtimeImportedBy = runtimeDependentCounts[source] ?? 0;

  if (imports > maxImports) {
    violations.push(
      `${source}: imports ${imports} exceeds budget ${maxImports}`,
    );
  }
  if (runtimeImportedBy > maxImportedBy) {
    violations.push(
      `${source}: runtimeImportedBy ${runtimeImportedBy} exceeds budget ${maxImportedBy}`,
    );
  }
  if (allow.maxImports !== undefined && imports < allow.maxImports) {
    console.log(
      `${source}: imports ${imports} is below explicit budget ${allow.maxImports}; lower the baseline.`,
    );
  }
  if (
    allow.maxImportedBy !== undefined &&
    runtimeImportedBy < allow.maxImportedBy
  ) {
    console.log(
      `${source}: runtimeImportedBy ${runtimeImportedBy} is below explicit budget ${allow.maxImportedBy}; lower the baseline.`,
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
