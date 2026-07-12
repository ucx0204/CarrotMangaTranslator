// @ts-check
const {
  createAbortError,
  quoteCommandArg,
  renderCommandTemplate,
  shrinkBuffer,
} = require("./transport/shell-text.cjs");
const { runShellCommand } = require("./transport/shell-command.cjs");
const {
  terminateChildProcessTree,
} = require("./transport/process-termination.cjs");

module.exports = {
  createAbortError,
  quoteCommandArg,
  renderCommandTemplate,
  runShellCommand,
  shrinkBuffer,
  terminateChildProcessTree,
};
