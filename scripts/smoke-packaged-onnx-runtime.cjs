const { readdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { pathToFileURL } = require("node:url");

/**
 * Load the packaged ONNX Node entry while supplying the same external runtime
 * paths used by first-use downloads. A deliberately invalid model reaches the
 * native parser only after the ESM glue and WASM binary initialize.
 *
 * @param {string} runtimeEntryPath
 * @param {string} wasmModulePath
 * @param {string} wasmBinaryPath
 * @param {{ log?: (message: string) => void }} [options]
 */
async function smokePackagedOnnxRuntime(
  runtimeEntryPath,
  wasmModulePath,
  wasmBinaryPath,
  options = {},
) {
  if (!runtimeEntryPath || !wasmModulePath || !wasmBinaryPath) {
    throw new Error(
      "Packaged ONNX entry, module, and WASM paths are required.",
    );
  }
  const packagedDistFiles = readdirSync(dirname(runtimeEntryPath)).sort();
  if (
    packagedDistFiles.length !== 1 ||
    packagedDistFiles[0] !== "ort.node.min.js"
  ) {
    throw new Error(
      `Unexpected packaged ONNX distribution files: ${packagedDistFiles.join(", ")}`,
    );
  }

  const ort = require(runtimeEntryPath);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: pathToFileURL(wasmModulePath).href,
    wasm: pathToFileURL(wasmBinaryPath).href,
  };

  let parserError;
  try {
    const session = await ort.InferenceSession.create(Uint8Array.of(0));
    await session.release();
  } catch (error) {
    parserError = error;
  }
  const parserMessage =
    parserError instanceof Error ? parserError.message : String(parserError);
  if (!parserMessage.includes("protobuf parsing failed")) {
    throw new Error(
      `Packaged ONNX runtime did not reach the model parser: ${String(
        parserError instanceof Error
          ? (parserError.stack ?? parserError.message)
          : parserError,
      )}`,
    );
  }
  options.log?.("packaged-onnx-runtime-ok");
}

async function main() {
  await smokePackagedOnnxRuntime(
    process.argv[2],
    process.argv[3],
    process.argv[4],
    {
      log: (message) => console.log(message),
    },
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  smokePackagedOnnxRuntime,
};
