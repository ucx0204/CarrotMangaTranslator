const { execFileSync } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, relative } = require("node:path");

const eslintBin = join(
  process.cwd(),
  "node_modules",
  "eslint",
  "bin",
  "eslint.js",
);

/** @typedef {{ total: number, files?: Record<string, number> }} DetailedWarningBudget */
/** @typedef {number | DetailedWarningBudget} WarningBudget */

/** @type {Record<string, WarningBudget>} */
const warningBudgets = JSON.parse(
  readFileSync(join(__dirname, "lint-warning-baseline.json"), "utf8"),
);

function readEslintReport() {
  const reportDirectory = mkdtempSync(join(tmpdir(), "manga-eslint-"));
  const reportPath = join(reportDirectory, "report.json");
  try {
    runEslintReport(reportPath);
    return readFileSync(reportPath, "utf8");
  } finally {
    if (existsSync(reportPath)) {
      unlinkSync(reportPath);
    }
    rmdirSync(reportDirectory);
  }
}

/** @param {string} reportPath */
function runEslintReport(reportPath) {
  try {
    execFileSync(
      process.execPath,
      [eslintBin, ".", "--format", "json", "--output-file", reportPath],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  } catch (error) {
    if (existsSync(reportPath)) {
      return;
    }
    const outputError =
      error && typeof error === "object"
        ? /** @type {{ stderr?: unknown }} */ (error)
        : {};
    process.stderr.write(String(outputError.stderr ?? ""));
    throw error;
  }
}

const report = JSON.parse(readEslintReport());
/** @type {Record<string, number>} */
const warningCounts = {};
/** @type {Record<string, Record<string, number>>} */
const warningFileCounts = {};
let errorCount = 0;

for (const file of report) {
  errorCount += file.errorCount ?? 0;
  const relativePath = relative(process.cwd(), file.filePath).replace(
    /\\/g,
    "/",
  );
  for (const message of file.messages ?? []) {
    if (message.severity !== 1) {
      continue;
    }
    const ruleId = message.ruleId ?? "fatal";
    warningCounts[ruleId] = (warningCounts[ruleId] ?? 0) + 1;
    const fileCounts = (warningFileCounts[ruleId] ??= {});
    fileCounts[relativePath] = (fileCounts[relativePath] ?? 0) + 1;
  }
}

/** @param {WarningBudget | undefined} budget */
function totalBudget(budget) {
  return typeof budget === "number" ? budget : (budget?.total ?? 0);
}

const violations = [];
if (errorCount > 0) {
  violations.push(`eslint reported ${errorCount} errors`);
}

for (const [ruleId, count] of Object.entries(warningCounts)) {
  const budget = totalBudget(warningBudgets[ruleId]);
  if (count > budget) {
    violations.push(`${ruleId}: ${count} warnings exceeds budget ${budget}`);
  }

  const detailedBudget = warningBudgets[ruleId];
  if (typeof detailedBudget !== "object") {
    continue;
  }
  for (const [file, fileCount] of Object.entries(
    warningFileCounts[ruleId] ?? {},
  )) {
    const fileBudget = detailedBudget.files?.[file] ?? 0;
    if (fileCount > fileBudget) {
      violations.push(
        `${ruleId} in ${file}: ${fileCount} warnings exceeds file budget ${fileBudget}`,
      );
    }
  }
}

for (const [ruleId, configuredBudget] of Object.entries(warningBudgets)) {
  const budget = totalBudget(configuredBudget);
  if ((warningCounts[ruleId] ?? 0) < budget) {
    console.log(
      `${ruleId}: ${warningCounts[ruleId] ?? 0} warnings below budget ${budget}; lower the budget when ready.`,
    );
  }
  if (typeof configuredBudget !== "object") {
    continue;
  }
  for (const [file, fileBudget] of Object.entries(
    configuredBudget.files ?? {},
  )) {
    const fileCount = warningFileCounts[ruleId]?.[file] ?? 0;
    if (fileCount < fileBudget) {
      console.log(
        `${ruleId} in ${file}: ${fileCount} warnings below file budget ${fileBudget}; lower the budget when ready.`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Lint warning budget failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("lint warning budget passed");
