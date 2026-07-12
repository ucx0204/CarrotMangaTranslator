// @ts-check
// OCR-owned boundary for process environment and runtime reporting services.
// Keeping this dependency edge here prevents every OCR policy module from
// coupling directly to the runtime host implementation.

const {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  ROCM_CHILD_ENV_KEYS,
  buildWhitelistedChildEnv,
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides,
} = require("../simple-page-child-env.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
} = require("../simple-page-runtime-common.cjs");

module.exports = {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  ROCM_CHILD_ENV_KEYS,
  buildWhitelistedChildEnv,
  createDetailedError,
  emitRuntimeProgress,
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides,
};
