#!/usr/bin/env node
// @ts-check

const { createRequire } = require("node:module");
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  createWriteStream,
} = require("node:fs");
const { mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { finished } = require("node:stream/promises");

const [, , tarRuntimePath, zipRuntimePath, packagedManifestPath] = process.argv;
if (!tarRuntimePath || !zipRuntimePath || !packagedManifestPath) {
  throw new Error(
    "Expected packaged TAR runtime, ZIP runtime, and app.asar package paths.",
  );
}
const resolvedTarRuntimePath = path.resolve(tarRuntimePath);
const resolvedZipRuntimePath = path.resolve(zipRuntimePath);
const resolvedPackagedManifestPath = path.resolve(packagedManifestPath);

const temporaryRoot = mkdtempSync(joinTempPath("mgt-packaged-archives-"));

async function main() {
  try {
    const packagedRequire = createRequire(resolvedPackagedManifestPath);
    await verifyRealTarExtraction(packagedRequire);
    await verifyRealZipExtraction(packagedRequire);
    console.log("packaged-archive-runtimes-ok");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** @param {NodeJS.Require} packagedRequire */
async function verifyRealTarExtraction(packagedRequire) {
  const tar = /** @type {typeof import("tar")} */ (packagedRequire("tar"));
  const sourceRoot = path.join(temporaryRoot, "tar-source");
  const payloadRoot = path.join(sourceRoot, "payload");
  const archivePath = path.join(temporaryRoot, "runtime.tar.gz");
  const outputRoot = path.join(temporaryRoot, "tar-output");
  await mkdir(payloadRoot, { recursive: true });
  writeFileSync(
    path.join(payloadRoot, "libggml.0.13.1.dylib"),
    "trusted-metal-dylib",
  );
  symlinkSync(
    "libggml.0.13.1.dylib",
    path.join(payloadRoot, "libggml.0.dylib"),
  );
  symlinkSync("libggml.0.dylib", path.join(payloadRoot, "libggml.dylib"));
  await tar.c({ cwd: sourceRoot, file: archivePath, gzip: true }, [
    "payload/libggml.dylib",
    "payload/libggml.0.dylib",
    "payload/libggml.0.13.1.dylib",
  ]);

  const runtime = require(resolvedTarRuntimePath);
  await runtime.extractSelectedTarEntries(archivePath, outputRoot, () => true, {
    stripComponents: 1,
  });
  for (const fileName of [
    "libggml.dylib",
    "libggml.0.dylib",
    "libggml.0.13.1.dylib",
  ]) {
    if (
      readFileSync(path.join(outputRoot, fileName), "utf8") !==
      "trusted-metal-dylib"
    ) {
      throw new Error(`Packaged TAR extraction corrupted ${fileName}.`);
    }
  }
}

/** @param {NodeJS.Require} packagedRequire */
async function verifyRealZipExtraction(packagedRequire) {
  const { ZipFile } = /** @type {typeof import("yazl")} */ (
    packagedRequire("yazl")
  );
  const archivePath = path.join(temporaryRoot, "runtime.zip");
  const outputRoot = path.join(temporaryRoot, "zip-output");
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from("trusted-zip-payload"), "nested/payload.txt");
  const output = createWriteStream(archivePath);
  zip.outputStream.pipe(output);
  zip.end();
  await finished(output);

  const runtime = require(resolvedZipRuntimePath);
  await runtime.extractSelectedZipEntries(archivePath, outputRoot, () => true, {
    preserveRelativePaths: true,
  });
  const extracted = readFileSync(
    path.join(outputRoot, "nested", "payload.txt"),
    "utf8",
  );
  if (extracted !== "trusted-zip-payload") {
    throw new Error("Packaged yauzl extraction corrupted its payload.");
  }
}

/** @param {string} prefix */
function joinTempPath(prefix) {
  return path.join(tmpdir(), prefix);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
