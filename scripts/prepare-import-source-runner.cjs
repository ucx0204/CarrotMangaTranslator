#!/usr/bin/env node
// @ts-check

const { copyFileSync, chmodSync, existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
const runnerRoot = join(root, "tools", "mgt-import-source-runner");
const manifestPath = join(runnerRoot, "Cargo.toml");
const executable =
  process.platform === "win32"
    ? "mgt-import-source-runner.exe"
    : "mgt-import-source-runner";

/** @param {string[]} argv */
function parseOptions(argv) {
  const targetIndex = argv.indexOf("--target");
  return {
    target:
      targetIndex >= 0 && argv[targetIndex + 1]
        ? argv[targetIndex + 1]
        : undefined,
    copyCanonical: !argv.includes("--no-copy"),
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ capture?: boolean }} [options]
 * @returns {string}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      CARGO_INCREMENTAL: "0",
      RUSTFLAGS: [
        process.env.RUSTFLAGS || "",
        "--remap-path-prefix=" + root + "=.",
      ]
        .filter(Boolean)
        .join(" "),
    },
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      command +
        " failed with exit code " +
        String(result.status ?? "null") +
        (result.stderr ? ": " + String(result.stderr).trim() : ""),
    );
  }
  return options.capture ? String(result.stdout).trim() : "";
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const args = [
    "build",
    "--manifest-path",
    manifestPath,
    "--locked",
    "--release",
  ];
  if (options.target) args.push("--target", options.target);
  run("cargo", args);

  const sourcePath = join(
    runnerRoot,
    "target",
    ...(options.target ? [options.target] : []),
    "release",
    executable,
  );
  if (!existsSync(sourcePath)) {
    throw new Error(
      "Import source runner build output is missing: " + sourcePath,
    );
  }
  if (process.platform !== "win32") chmodSync(sourcePath, 0o755);
  const capabilities = JSON.parse(
    run(sourcePath, ["capabilities"], { capture: true }),
  );
  if (
    capabilities?.version !== 1 ||
    JSON.stringify(capabilities?.formats) !==
      JSON.stringify(["pdf", "rar", "cbr"])
  ) {
    throw new Error("Import source runner capabilities are invalid");
  }
  if (options.copyCanonical) {
    const canonicalPath = join(runnerRoot, executable);
    copyFileSync(sourcePath, canonicalPath);
    if (process.platform !== "win32") chmodSync(canonicalPath, 0o755);
    console.log("[import-runner] prepared " + canonicalPath);
  } else {
    console.log("[import-runner] verified " + sourcePath);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseOptions };
