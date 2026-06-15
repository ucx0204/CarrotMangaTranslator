const { execFileSync } = require("node:child_process");

const forbiddenPathPatterns = [
  /(^|\/)__pycache__(\/|$)/,
  /\.pyc$/i,
  /^settings\.json$/,
  /^logs(\/|$)/,
  /^models(\/|$)/,
  /^library(\/|$)/,
];

function listGitVisibleFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

const offenders = listGitVisibleFiles().filter((filePath) =>
  forbiddenPathPatterns.some((pattern) => pattern.test(filePath)),
);

if (offenders.length > 0) {
  console.error("Generated/local files must not be committed or packaged:");
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  console.error("Run npm run clean:generated or move local data out of repo.");
  process.exit(1);
}

console.log("generated/local file guard passed");
