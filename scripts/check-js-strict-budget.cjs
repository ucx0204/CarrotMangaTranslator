const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const baseline = JSON.parse(
  readFileSync(join(__dirname, "js-strict-baseline.json"), "utf8"),
);
const tscBin = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");

function runStrictJsCheck() {
  try {
    execFileSync(
      process.execPath,
      [tscBin, "-p", "tsconfig.checkjs.json", "--noImplicitAny", "true"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return "";
  } catch (error) {
    const outputError =
      error && typeof error === "object"
        ? /** @type {{ stdout?: unknown; stderr?: unknown }} */ (error)
        : {};
    return `${String(outputError.stdout ?? "")}${String(outputError.stderr ?? "")}`;
  }
}

const output = runStrictJsCheck();
const count = [...output.matchAll(/error TS\d+:/g)].length;

if (count > baseline.errors) {
  console.error(
    `JS strict budget failed: ${count} errors exceeds baseline ${baseline.errors}.`,
  );
  process.exit(1);
}

if (count < baseline.errors) {
  console.log(
    `JS strict errors below baseline: ${count} < ${baseline.errors}; lower scripts/js-strict-baseline.json when ready.`,
  );
}

console.log("JS strict budget passed");
