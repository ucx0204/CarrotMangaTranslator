const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
const workTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
  windowsHide: true,
});
if (workTree.status !== 0 || workTree.stdout.trim() !== "true") {
  console.log("Git worktree unavailable; repository hooks were not installed.");
  process.exit(0);
}

const configured = spawnSync(
  "git",
  ["config", "--local", "core.hooksPath", ".githooks"],
  {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  },
);
if (configured.error || configured.status !== 0) {
  console.error(
    configured.error || configured.stderr || "Failed to install Git hooks.",
  );
  process.exit(configured.status ?? 1);
}

console.log("repository Git hooks installed from .githooks");
