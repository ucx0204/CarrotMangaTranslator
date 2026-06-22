const { existsSync, readFileSync } = require("node:fs");
const { join, relative } = require("node:path");
const { execFileSync } = require("node:child_process");

const forbiddenPatterns = [
  {
    name: "promise-catch-undefined",
    pattern: /\.catch\(\s*\(\s*\)\s*=>\s*undefined\s*\)/,
    message:
      "Do not silently swallow promise failures with .catch(() => undefined).",
  },
  {
    name: "promise-catch-empty-block",
    pattern: /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
    message: "Do not silently swallow promise failures with .catch(() => {}).",
  },
  {
    name: "empty-catch-block",
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    message:
      "Empty catch blocks are not allowed; handle, log, or document an allowlisted boundary.",
  },
  {
    name: "catch-return-null",
    pattern: /catch\s*\([^)]*\)\s*\{\s*return\s+null\s*;\s*\}/,
    message:
      "Do not turn caught failures into null outside an explicit boundary.",
  },
];

function listCandidateFiles() {
  const output = execFileSync("git", ["ls-files"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .filter((file) => /^(src|scripts|tests)\//.test(file))
    .filter((file) => /\.(cjs|mjs|js|ts|tsx)$/.test(file));
}

const violations = [];
for (const file of listCandidateFiles()) {
  const absolutePath = join(process.cwd(), file);
  if (!existsSync(absolutePath)) {
    continue;
  }
  const text = readFileSync(absolutePath, "utf8");
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of forbiddenPatterns) {
      if (rule.pattern.test(line)) {
        violations.push({
          file: relative(process.cwd(), absolutePath),
          line: index + 1,
          rule,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Error handling policy failed:");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.rule.name}: ${violation.rule.message}`,
    );
  }
  process.exit(1);
}

console.log("error handling policy passed");
