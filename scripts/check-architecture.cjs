const {
  evaluateArchitectureBudget,
  readDepcruiseReport,
} = require("./check-architecture-budget.cjs");

/**
 * @typedef {{
 *   from?: string;
 *   to?: string;
 *   rule?: string | { name?: string };
 *   cycle?: string[];
 * }} DepcruiseViolation
 * @typedef {{
 *   coreModule?: boolean;
 *   couldNotResolve?: boolean;
 *   dependencyTypes?: string[];
 *   resolved?: string;
 * }} DepcruiseDependency
 * @typedef {{
 *   source: string;
 *   dependencies?: DepcruiseDependency[];
 * }} DepcruiseModule
 * @typedef {{
 *   modules?: DepcruiseModule[];
 *   summary?: {
 *     error?: number;
 *     totalCruised?: number;
 *     totalDependenciesCruised?: number;
 *     violations?: DepcruiseViolation[];
 *   };
 * }} DepcruiseReport
 */

/** @param {DepcruiseViolation} violation */
function describeDependencyViolation(violation) {
  const rule =
    typeof violation.rule === "string"
      ? violation.rule
      : (violation.rule?.name ?? "unknown-rule");
  const route = [violation.from, violation.to].filter(Boolean).join(" -> ");
  const cycle = violation.cycle?.length
    ? ` (${violation.cycle.join(" -> ")})`
    : "";
  return `${rule}${route ? `: ${route}` : ""}${cycle}`;
}

function runArchitectureCheck() {
  /** @type {DepcruiseReport} */
  const report = JSON.parse(readDepcruiseReport());
  const dependencyViolations = report.summary?.violations ?? [];
  const dependencyErrorCount = report.summary?.error ?? 0;
  const budget = evaluateArchitectureBudget(report);

  for (const notice of budget.notices) {
    console.log(notice);
  }

  if (dependencyErrorCount > 0) {
    console.error("Architecture dependency rules failed:");
    if (dependencyViolations.length === 0) {
      console.error(
        `- dependency-cruiser reported ${dependencyErrorCount} errors`,
      );
    }
    for (const violation of dependencyViolations) {
      console.error(`- ${describeDependencyViolation(violation)}`);
    }
  }

  if (budget.violations.length > 0) {
    console.error("Architecture budget failed:");
    for (const violation of budget.violations) {
      console.error(`- ${violation}`);
    }
  }

  if (dependencyErrorCount > 0 || budget.violations.length > 0) {
    return false;
  }

  const modules = report.summary?.totalCruised ?? report.modules?.length ?? 0;
  const dependencies = report.summary?.totalDependenciesCruised ?? 0;
  console.log(
    `architecture dependency rules and budget passed (${modules} modules, ${dependencies} dependencies)`,
  );
  return true;
}

module.exports = {
  describeDependencyViolation,
  runArchitectureCheck,
};

if (require.main === module && !runArchitectureCheck()) {
  process.exitCode = 1;
}
