// @ts-check
const {
  createAbortError,
  formatCommandForLog,
  shrinkBuffer,
} = require("./transport/shell-text.cjs");
const { runCommand } = require("./transport/shell-command.cjs");
const {
  terminateChildProcessTree,
} = require("./transport/process-termination.cjs");

module.exports = {
  createAbortError,
  formatCommandForLog,
  runCommand,
  shrinkBuffer,
  terminateChildProcessTree,
};
