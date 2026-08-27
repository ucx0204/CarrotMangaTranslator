const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const CODEX_APP_SERVER_VERSION = "0.150.1";
const CODEX_RUNTIME_RESOURCE_DIRECTORY = "c";
const CODEX_APP_SERVER_CONFIG_OVERRIDES = [
  'cli_auth_credentials_store="file"',
  'forced_login_method="chatgpt"',
  'history.persistence="none"',
  "project_doc_max_bytes=0",
  "project_doc_fallback_filenames=[]",
  "mcp_servers={}",
  "apps={}",
  "plugins={}",
  "marketplaces={}",
  'web_search="disabled"',
  "check_for_update_on_startup=false",
  "feedback.enabled=false",
];
const CODEX_APP_SERVER_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "computer_use",
  "goals",
  "guardian_approval",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_chat",
  "in_app_dictation",
  "in_app_local_automation",
  "in_app_updates",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "request_permissions_tool",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "web_search",
  "workspace_dependencies",
];
const CODEX_APP_SERVER_ARGUMENTS = [
  "app-server",
  ...CODEX_APP_SERVER_CONFIG_OVERRIDES.flatMap((override) => ["-c", override]),
  ...CODEX_APP_SERVER_DISABLED_FEATURES.flatMap((feature) => [
    "--disable",
    feature,
  ]),
  "--strict-config",
  "--listen",
  "stdio://",
];

/**
 * @typedef {{ packageName: string; triple: string; executable: string }} CodexTarget
 * @typedef {CodexTarget & {
 *   packageRoot: string;
 *   packageJsonPath: string;
 *   sourceDir: string;
 *   manifestPath: string;
 *   executablePath: string;
 *   resourceDirectory: string;
 * }} CodexRuntime
 */

/** @type {Record<string, CodexTarget>} */
const TARGETS = {
  "win32/x64": {
    packageName: "@openai/codex-win32-x64",
    triple: "x86_64-pc-windows-msvc",
    executable: "bin/codex.exe",
  },
  "darwin/arm64": {
    packageName: "@openai/codex-darwin-arm64",
    triple: "aarch64-apple-darwin",
    executable: "bin/codex",
  },
};

/** @param {string} root @param {string} platform @param {string} arch @returns {CodexRuntime} */
function resolveCodexRuntime(root, platform, arch) {
  const target = TARGETS[`${platform}/${arch}`];
  if (!target) {
    throw new Error(`Unsupported bundled Codex target: ${platform}/${arch}`);
  }
  const packageRoot = join(
    root,
    "node_modules",
    ...target.packageName.split("/"),
  );
  const packageJsonPath = join(packageRoot, "package.json");
  const sourceDir = join(packageRoot, "vendor", target.triple);
  const manifestPath = join(sourceDir, "codex-package.json");
  const executablePath = join(sourceDir, ...target.executable.split("/"));
  return {
    ...target,
    packageRoot,
    packageJsonPath,
    sourceDir,
    manifestPath,
    executablePath,
    resourceDirectory: CODEX_RUNTIME_RESOURCE_DIRECTORY,
  };
}

/** @param {CodexRuntime} runtime @returns {CodexRuntime} */
function assertCodexRuntimeReady(runtime) {
  for (const filePath of [
    runtime.packageJsonPath,
    runtime.manifestPath,
    runtime.executablePath,
  ]) {
    if (!existsSync(filePath)) {
      throw new Error(`Bundled Codex runtime input is missing: ${filePath}`);
    }
  }
  const packageJson = readJson(runtime.packageJsonPath);
  const manifest = readJson(runtime.manifestPath);
  const expectedPackageVersion = `${CODEX_APP_SERVER_VERSION}-${packageSuffix(
    runtime,
  )}`;
  if (packageJson.version !== expectedPackageVersion) {
    throw new Error(
      `Codex platform package version mismatch: ${String(packageJson.version)}`,
    );
  }
  if (
    manifest.version !== CODEX_APP_SERVER_VERSION ||
    manifest.target !== runtime.triple ||
    manifest.entrypoint !== runtime.executable
  ) {
    throw new Error(
      "Codex runtime manifest does not match the pinned package.",
    );
  }
  return runtime;
}

/** @param {CodexRuntime} runtime */
function packageSuffix(runtime) {
  const match = runtime.packageName.match(/codex-(win32|darwin)-(x64|arm64)$/u);
  if (!match)
    throw new Error(`Invalid Codex package name: ${runtime.packageName}`);
  return `${match[1]}-${match[2]}`;
}

/** @param {string} filePath @returns {Record<string, unknown>} */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

module.exports = {
  CODEX_APP_SERVER_ARGUMENTS,
  CODEX_APP_SERVER_VERSION,
  CODEX_RUNTIME_RESOURCE_DIRECTORY,
  assertCodexRuntimeReady,
  resolveCodexRuntime,
};
