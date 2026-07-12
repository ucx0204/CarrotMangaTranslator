// @ts-check

// Keep the model transport layer's dependency on the broad runtime utility
// module behind one explicit host-services boundary.
const {
  createDetailedError,
  emitRuntimeProgress,
  nowMs,
  truncateText,
} = require("../simple-page-runtime-common.cjs");

module.exports = {
  createDetailedError,
  emitRuntimeProgress,
  nowMs,
  truncateText,
};
