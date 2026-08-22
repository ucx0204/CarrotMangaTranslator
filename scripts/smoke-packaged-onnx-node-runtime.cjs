const { readdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { Worker: NodeWorker } = require("node:worker_threads");

const EXPECTED_BACKENDS =
  process.platform === "win32" ? ["cpu", "dml"] : ["cpu"];

/**
 * Loads the native runtime from app.asar and verifies that the packaged
 * target binary exposes the expected execution providers and that the font
 * proxy resolves the same staged runtime both on the main thread and worker.
 *
 * @param {string} runtimeEntryPath
 * @param {string} nativeRuntimeModulePath
 * @param {string} crossScriptProxyModulePath
 * @param {{ log?: (message: string) => void }} [options]
 */
async function smokePackagedOnnxNodeRuntime(
  runtimeEntryPath,
  nativeRuntimeModulePath,
  crossScriptProxyModulePath,
  options = {},
) {
  if (
    !runtimeEntryPath ||
    !nativeRuntimeModulePath ||
    !crossScriptProxyModulePath
  ) {
    throw new Error(
      "Packaged onnxruntime-node entry, shared loader, and font proxy module paths are required.",
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
  const wrapper = require(nativeRuntimeModulePath);
  if (wrapper.onnxRuntimeNode !== ort) {
    throw new Error(
      "Packaged native ONNX loader did not resolve the staged runtime.",
    );
  }
  if (
    resolve(wrapper.resolvePackagedOnnxRuntimeNodeEntry()) !==
    resolve(runtimeEntryPath)
  ) {
    throw new Error("Packaged native ONNX entry path drifted.");
  }
  const proxy = require(crossScriptProxyModulePath);
  if (typeof proxy.inferCrossScriptProxyPage !== "function") {
    throw new Error(
      "Packaged font cross-script proxy could not load the staged native runtime.",
    );
  }
  await assertWorkerCanLoadCrossScriptProxy(crossScriptProxyModulePath);
  options.log?.(
    `packaged-onnx-node-runtime-ok:${EXPECTED_BACKENDS.join(",")},font-proxy`,
  );
}

/**
 * @param {string} crossScriptProxyModulePath
 * @returns {Promise<void>}
 */
function assertWorkerCanLoadCrossScriptProxy(crossScriptProxyModulePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const worker = new NodeWorker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        try {
          const proxy = require(workerData.crossScriptProxyModulePath);
          parentPort.postMessage({
            ok: typeof proxy.inferCrossScriptProxyPage === "function",
            resourcesPath: process.resourcesPath ?? null,
          });
        } catch (error) {
          parentPort.postMessage({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      `,
      { eval: true, workerData: { crossScriptProxyModulePath } },
    );
    /** @param {Error} [error] */
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timeout = setTimeout(
      () => finish(new Error("Packaged font proxy worker smoke timed out.")),
      15_000,
    );
    worker.once("message", (message) => {
      if (message?.ok === true && typeof message.resourcesPath === "string") {
        finish();
        return;
      }
      finish(
        new Error(
          `Packaged font proxy worker failed to load the native runtime: ${String(message?.error ?? "missing resourcesPath")}`,
        ),
      );
    });
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!settled) {
        finish(
          new Error(`Packaged font proxy worker exited before ready: ${code}`),
        );
      }
    });
  });
}

async function main() {
  await smokePackagedOnnxNodeRuntime(
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

module.exports = { smokePackagedOnnxNodeRuntime };
