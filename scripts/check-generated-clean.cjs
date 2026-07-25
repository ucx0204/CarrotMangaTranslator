const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");

const forbiddenPathPatterns = [
  /(^|\/)__pycache__(\/|$)/,
  /\.pyc$/i,
  /^settings\.json$/,
  /^logs(\/|$)/,
  /^models(\/|$)/,
  /^library(\/|$)/,
];
const checkedNativeArtifacts = [
  "tools/mgt-koharu-inpaint-runner/mgt-koharu-inpaint-runner.exe",
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

const nativePathLeaks = checkedNativeArtifacts.filter(
  (filePath) =>
    existsSync(filePath) &&
    readFileSync(filePath).includes(Buffer.from("C:\\Users\\", "utf8")),
);
if (nativePathLeaks.length > 0) {
  console.error("Native artifacts contain a local Windows user path:");
  for (const offender of nativePathLeaks) {
    console.error(`- ${offender}`);
  }
  console.error("Rebuild with rustc --remap-path-prefix before committing.");
  process.exit(1);
}

console.log("generated/local file guard passed");
