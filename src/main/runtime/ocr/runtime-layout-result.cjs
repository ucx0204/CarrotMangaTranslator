// @ts-check
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/**
 * @typedef {{
 *   runtimeDir: string;
 *   runtimeVariant: string;
 *   packageDir: string;
 *   cachePaths: OcrRuntimeLayout;
 *   diagnostics: unknown[];
 * }} RuntimeLayoutState
 */

/** @param {RuntimeLayoutState} state @param {string} pythonPath @param {boolean} usesTargetPackageDir @returns {OcrRuntimeLayout} */
function buildRuntimeLayout(state, pythonPath, usesTargetPackageDir) {
  return {
    runtimeDir: state.runtimeDir,
    runtimeVariant: state.runtimeVariant,
    packageDir: state.packageDir,
    pythonPath,
    prepared: true,
    usesTargetPackageDir,
    diagnostics: state.diagnostics,
    ...state.cachePaths,
  };
}

module.exports = { buildRuntimeLayout };
