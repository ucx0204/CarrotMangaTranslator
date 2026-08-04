"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

async function run() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Missing runtime validation input path.");
  const input = JSON.parse(await fsp.readFile(inputPath, "utf8"));
  if (
    typeof input?.root !== "string" ||
    typeof input?.artifactDir !== "string" ||
    !Array.isArray(input?.installedCandidates)
  ) {
    throw new Error("Invalid runtime validation input.");
  }
  const runtimeStatus = require(
    path.join(
      input.root,
      "out/main/pipeline/fontMatchingRuntimeArtifactStatus.js",
    ),
  );
  const status = await runtimeStatus.loadFontMatchingRuntimeArtifactStatus({
    artifactDir: input.artifactDir,
    allowQaOnlyRuntime: input.allowQaOnlyRuntime === true,
    installedCandidates: input.installedCandidates,
  });
  process.stdout.write(JSON.stringify(status));
}
