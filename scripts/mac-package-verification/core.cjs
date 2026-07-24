const { spawnSync } = require("node:child_process");
const {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const ELECTRON_FRAMEWORK_EXECUTABLE = join(
  "Contents",
  "Frameworks",
  "Electron Framework.framework",
  "Versions",
  "A",
  "Electron Framework",
);
const ELECTRON_HELPER_SUFFIXES = [
  "Helper",
  "Helper (GPU)",
  "Helper (Plugin)",
  "Helper (Renderer)",
];

/**
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {"stable" | "mac-alpha"}
 */
function resolveMacPackageChannel(environment = process.env) {
  const channel = String(
    environment.MANGA_TRANSLATOR_BUILD_CHANNEL ||
      environment.MGT_RELEASE_CHANNEL ||
      "",
  ).trim();
  return channel === "stable" ? "stable" : "mac-alpha";
}

/**
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {"SHA256SUMS-macOS-arm64.txt" | "SHA256SUMS-mac-alpha.txt"}
 */
function resolveMacChecksumFileName(environment = process.env) {
  return resolveMacPackageChannel(environment) === "stable"
    ? "SHA256SUMS-macOS-arm64.txt"
    : "SHA256SUMS-mac-alpha.txt";
}

/** @typedef {{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error }} CommandResult */

/** @param {string} command @param {string[]} args @param {{ env?: NodeJS.ProcessEnv; input?: string; timeout?: number }} [options] @returns {CommandResult} */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    shell: false,
    timeout: options.timeout,
  });
  const normalized = {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    ...(result.error ? { error: result.error } : {}),
  };
  if (normalized.error || normalized.status !== 0) {
    const failure = [
      normalized.error?.message,
      normalized.signal ? `signal ${normalized.signal}` : null,
      normalized.status === null ? null : `exit ${normalized.status}`,
      normalized.stderr,
      normalized.stdout,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`${command} ${args.join(" ")} failed: ${failure}`);
  }
  return normalized;
}

/** @param {string} directory @returns {string[]} */
function listFiles(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

/** @param {string} directory @returns {string[]} */
function findAppBundles(directory) {
  /** @type {string[]} */
  const apps = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.endsWith(".app")) {
      apps.push(entryPath);
    } else {
      apps.push(...findAppBundles(entryPath));
    }
  }
  return apps;
}

/** @param {string} directory @param {string} artifactLabel */
function findSingleAppBundle(directory, artifactLabel) {
  const apps = findAppBundles(directory);
  if (apps.length !== 1) {
    throw new Error(
      `Expected one .app in ${artifactLabel}, found ${apps.length}: ${apps.join(", ") || "none"}`,
    );
  }
  return apps[0];
}

/** @param {string} appPath */
function assertElectronFrameworkExecutable(appPath) {
  const frameworkExecutable = join(appPath, ELECTRON_FRAMEWORK_EXECUTABLE);
  if (!existsSync(frameworkExecutable)) {
    throw new Error(
      `Final app is missing the Electron Framework executable: ${frameworkExecutable}`,
    );
  }
  const metadata = statSync(frameworkExecutable);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(
      `Final app has an invalid Electron Framework executable: ${frameworkExecutable}`,
    );
  }
}

/** @param {string} appPath */
function assertElectronHelperExecutables(appPath) {
  for (const suffix of ELECTRON_HELPER_SUFFIXES) {
    const helperName = `CarrotMangaTranslator ${suffix}`;
    const helperExecutable = join(
      appPath,
      "Contents",
      "Frameworks",
      `${helperName}.app`,
      "Contents",
      "MacOS",
      helperName,
    );
    if (!existsSync(helperExecutable)) {
      throw new Error(
        `Final app is missing the ASCII Electron Helper executable: ${helperExecutable}`,
      );
    }
    const metadata = statSync(helperExecutable);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(
        `Final app has an invalid Electron Helper executable: ${helperExecutable}`,
      );
    }
  }
}

/** @param {string} filePath */
function looksLikeNativeBinary(filePath) {
  const metadata = lstatSync(filePath);
  return (
    (metadata.mode & 0o111) !== 0 ||
    /\.(?:dylib|so|node)$/i.test(filePath) ||
    filePath.includes(`${join("Contents", "Frameworks")}`)
  );
}

/** @param {string} filePath */
function requiresOtoolAlias(filePath) {
  return /[()]/.test(filePath);
}

/**
 * otool-classic interprets a trailing parenthesized filename segment such as
 * "Helper (GPU)" as the archive(member) syntax. Inspect the same Mach-O through
 * a parenthesis-free symlink so the tool receives an unambiguous path.
 *
 * @param {string} filePath
 */
function runOtool(filePath) {
  if (!requiresOtoolAlias(filePath)) {
    return run("otool", ["-L", filePath]);
  }
  const aliasRoot = mkdtempSync(join(tmpdir(), "mgt-otool-"));
  const aliasPath = join(aliasRoot, "native-payload");
  try {
    symlinkSync(filePath, aliasPath);
    return run("otool", ["-L", aliasPath]);
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true });
  }
}

module.exports = {
  assertElectronFrameworkExecutable,
  assertElectronHelperExecutables,
  findAppBundles,
  findSingleAppBundle,
  listFiles,
  looksLikeNativeBinary,
  requiresOtoolAlias,
  resolveMacChecksumFileName,
  resolveMacPackageChannel,
  run,
  runOtool,
};
