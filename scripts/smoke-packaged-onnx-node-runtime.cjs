const { readdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const EXPECTED_BACKENDS = ["cpu", "dml"];

/**
 * Loads the native runtime from app.asar and verifies that the packaged
 * Windows binary exposes both CPU and vendor-neutral DirectML execution.
 *
 * @param {string} runtimeEntryPath
 * @param {string} nativeOrtModulePath
 * @param {{ log?: (message: string) => void }} [options]
 */
function smokePackagedOnnxNodeRuntime(
  runtimeEntryPath,
  nativeOrtModulePath,
  options = {},
) {
  if (!runtimeEntryPath || !nativeOrtModulePath) {
    throw new Error(
      "Packaged onnxruntime-node entry and nativeOrt module paths are required.",
    );
  }
  const packagedDistFiles = readdirSync(dirname(runtimeEntryPath)).sort();
  if (!packagedDistFiles.includes("index.js")) {
    throw new Error(
      `Packaged onnxruntime-node entry is missing: ${packagedDistFiles.join(", ")}`,
    );
  }
  /**
   * @type {{
   *   env?: { versions?: { node?: string } };
   *   listSupportedBackends: () => { name: string; bundled: boolean }[];
   * }}
   */
  const ort = require(runtimeEntryPath);
  if (ort.env?.versions?.node !== "1.27.0") {
    throw new Error(
      `Unexpected packaged onnxruntime-node version: ${String(ort.env?.versions?.node)}`,
    );
  }
  const supported = new Set(
    ort
      .listSupportedBackends()
      .filter((backend) => backend.bundled)
      .map((backend) => backend.name),
  );
  for (const backend of EXPECTED_BACKENDS) {
    if (!supported.has(backend)) {
      throw new Error(`Packaged ONNX backend is missing: ${backend}`);
    }
  }
  const wrapper = require(nativeOrtModulePath);
  if (wrapper.onnxRuntimeNode !== ort) {
    throw new Error("Packaged nativeOrt did not resolve the staged runtime.");
  }
  if (
    resolve(wrapper.resolvePackagedOnnxRuntimeNodeEntry()) !==
    resolve(runtimeEntryPath)
  ) {
    throw new Error("Packaged nativeOrt entry path drifted.");
  }
  options.log?.("packaged-onnx-node-runtime-ok:dml,cpu");
}

function main() {
  smokePackagedOnnxNodeRuntime(process.argv[2], process.argv[3], {
    log: (message) => console.log(message),
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { smokePackagedOnnxNodeRuntime };
