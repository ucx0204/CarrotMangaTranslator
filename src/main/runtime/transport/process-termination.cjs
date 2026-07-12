// @ts-check
const { spawn } = require("node:child_process");
const { buildUtilityChildEnv } = require("../simple-page-child-env.cjs");

/** @param {import("node:child_process").ChildProcess} child */
function terminateChildProcessTree(child) {
  if (!isRunningChild(child)) return;
  if (process.platform !== "win32" || !child.pid) {
    child.kill("SIGKILL");
    return;
  }
  terminateWindowsProcessTree(child);
}

/** @param {import("node:child_process").ChildProcess} child */
function isRunningChild(child) {
  return Boolean(
    child &&
    !child.killed &&
    child.exitCode === null &&
    child.signalCode === null,
  );
}

/** @param {import("node:child_process").ChildProcess} child */
function terminateWindowsProcessTree(child) {
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
    env: buildUtilityChildEnv({}),
  });
  killer.on("error", () => child.kill("SIGKILL"));
  killer.on("close", (code) => {
    if (code !== 0 && isRunningChild(child)) child.kill("SIGKILL");
  });
}

module.exports = { terminateChildProcessTree };
