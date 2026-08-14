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
  const args = [
    depcruiseBin,
    "--config",
    ".dependency-cruiser.cjs",
    "--include-only",
    "^src",
    "--output-type",
    "json",
    "src",
  ];
  try {
    return execFileSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const processError =
      error && typeof error === "object"
        ? /** @type {{ stdout?: unknown; stderr?: unknown }} */ (error)
        : {};
    const stdout = String(processError.stdout ?? "");
    if (stdout.trim()) {
      return stdout;
    }
    process.stderr.write(String(processError.stderr ?? ""));
    throw error;
  }
}

/**
 * @param {{ modules?: DepcruiseModule[] }} report
 * @returns {{ violations: string[]; notices: string[] }}
 */
function evaluateArchitectureBudget(report) {
  const violations = [];
  const notices = [];
  const runtimeDependentCounts = countRuntimeDependents(report.modules ?? []);

  for (const moduleInfo of report.modules ?? []) {
    const result = evaluateModuleBudget(moduleInfo, runtimeDependentCounts);
    violations.push(...result.violations);
    notices.push(...result.notices);
  }

  return { violations, notices };
}

/** @param {DepcruiseDependency} dependency */
function isRuntimeDependency(dependency) {
  return Boolean(
    !dependency.coreModule &&
    !dependency.couldNotResolve &&
    !dependency.dependencyTypes?.includes("type-only") &&
    dependency.resolved,
  );
}

/** @param {DepcruiseModule[]} modules */
function countRuntimeDependents(modules) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const moduleInfo of modules) {
    for (const dependency of moduleInfo.dependencies ?? []) {
      if (!isRuntimeDependency(dependency) || !dependency.resolved) continue;
      counts[dependency.resolved] = (counts[dependency.resolved] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * @param {DepcruiseModule} moduleInfo
 * @param {Record<string, number>} runtimeDependentCounts
 */
function evaluateModuleBudget(moduleInfo, runtimeDependentCounts) {
  const source = moduleInfo.source;
  const allow = baseline.allow?.[source] ?? {};
  const maxImports = allow.maxImports ?? baseline.defaultMaxImports;
  const maxImportedBy = allow.maxImportedBy ?? baseline.defaultMaxImportedBy;
  const imports = (moduleInfo.dependencies ?? []).filter(
    (dependency) => !dependency.coreModule && !dependency.couldNotResolve,
  ).length;
  const runtimeImportedBy = runtimeDependentCounts[source] ?? 0;
  const violations = [];
  const notices = [];

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
    notices.push(
      `${source}: imports ${imports} is below explicit budget ${allow.maxImports}; lower the baseline.`,
    );
  }
  if (
    allow.maxImportedBy !== undefined &&
    runtimeImportedBy < allow.maxImportedBy
  ) {
    notices.push(
      `${source}: runtimeImportedBy ${runtimeImportedBy} is below explicit budget ${allow.maxImportedBy}; lower the baseline.`,
    );
  }
  return { violations, notices };
}

function runArchitectureBudgetCheck() {
  /** @type {{ modules?: DepcruiseModule[]; summary?: { error?: number } }} */
  const report = JSON.parse(readDepcruiseReport());
  const result = evaluateArchitectureBudget(report);
  const dependencyErrorCount = report.summary?.error ?? 0;
  for (const notice of result.notices) {
    console.log(notice);
  }
  if (dependencyErrorCount > 0) {
    console.error(
      `Architecture dependency rules failed with ${dependencyErrorCount} errors.`,
    );
  }
  if (result.violations.length > 0) {
    console.error("Architecture budget failed:");
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
  }
  if (dependencyErrorCount > 0 || result.violations.length > 0) return false;
  console.log("architecture budget passed");
  return true;
}

module.exports = {
  evaluateArchitectureBudget,
  readDepcruiseReport,
  runArchitectureBudgetCheck,
};

if (require.main === module && !runArchitectureBudgetCheck()) {
  process.exitCode = 1;
}
