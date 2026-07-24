#!/usr/bin/env node

const { formatUnknownError, main } = require("./flux-rocm-build/runner.cjs");

main().catch((error) => {
  console.error(formatUnknownError(error));
  process.exitCode = 1;
});
