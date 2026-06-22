const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const eslintBin = join(
  process.cwd(),
  "node_modules",
  "eslint",
  "bin",
  "eslint.js",
);

/** @type {Record<string, number>} */
const warningBudgets = JSON.parse(
  readFileSync(join(__dirname, "lint-warning-baseline.json"), "utf8"),
);

function readEslintReport() {
  try {
    return execFileSync(
      process.execPath,
      [eslintBin, ".", "--format", "json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const outputError =
      error && typeof error === "object"
        ? /** @type {{ stdout?: unknown; stderr?: unknown }} */ (error)
        : {};
    process.stderr.write(String(outputError.stdout ?? ""));
    process.stderr.write(String(outputError.stderr ?? ""));
    throw error;
  }
}

const report = JSON.parse(readEslintReport());
/** @type {Record<string, number>} */
const warningCounts = {};
let errorCount = 0;

for (const file of report) {
  errorCount += file.errorCount ?? 0;
  for (const message of file.messages ?? []) {
    if (message.severity !== 1) {
      continue;
    }
    const ruleId = message.ruleId ?? "fatal";
    warningCounts[ruleId] = (warningCounts[ruleId] ?? 0) + 1;
  }
}

const violations = [];
if (errorCount > 0) {
  violations.push(`eslint reported ${errorCount} errors`);
}

for (const [ruleId, count] of Object.entries(warningCounts)) {
  const budget = warningBudgets[ruleId] ?? 0;
  if (count > budget) {
    violations.push(`${ruleId}: ${count} warnings exceeds budget ${budget}`);
  }
}

for (const ruleId of Object.keys(warningBudgets)) {
  if ((warningCounts[ruleId] ?? 0) < warningBudgets[ruleId]) {
    console.log(
      `${ruleId}: ${warningCounts[ruleId] ?? 0} warnings below budget ${warningBudgets[ruleId]}; lower the budget when ready.`,
    );
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
