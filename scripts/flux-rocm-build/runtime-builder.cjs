const pythonSetup = require("./python-setup.cjs");
const pythonInstall = require("./python-install.cjs");
const { buildRuntimeEnv } = require("./runtime-env.cjs");
const runtimePackage = require("./runtime-package.cjs");

module.exports = {
  ...pythonSetup,
  ...pythonInstall,
  ...runtimePackage,
  buildRuntimeEnv,
};
