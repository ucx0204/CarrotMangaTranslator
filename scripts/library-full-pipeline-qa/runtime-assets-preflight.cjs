// @ts-check

const path = require("node:path");
const {
  createRuntimeAssetsCacheStep,
  runCachedBuildStep,
} = require("../dev-build-cache.cjs");
const { prepareRuntimeAssets } = require("../prepare-runtime.cjs");

/**
 * The full-pipeline harness loads runtime CJS indirectly through out/main.
 * compile:electron does not stage those files, so synchronize the complete
 * runtime tree before Electron starts instead of accepting a merely existing
 * stale out/app-runtime directory.
 *
 * @param {string} root
 */
function synchronizeQaRuntimeAssets(root) {
  const outputDir = path.join(root, "out", "app-runtime");
  return runCachedBuildStep(createRuntimeAssetsCacheStep(root, outputDir), () =>
    prepareRuntimeAssets({ root, outputDir }),
  );
}

module.exports = { synchronizeQaRuntimeAssets };
