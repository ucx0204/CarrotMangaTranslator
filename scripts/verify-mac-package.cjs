#!/usr/bin/env node

const core = require("./mac-package-verification/core.cjs");
const artifacts = require("./mac-package-verification/artifacts.cjs");
const {
  shouldAllowHostedGuiSmokeFailure,
} = require("./mac-package-verification/app-smoke.cjs");
const { main } = require("./mac-package-verification/runner.cjs");

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  ...core,
  ...artifacts,
  shouldAllowHostedGuiSmokeFailure,
};
