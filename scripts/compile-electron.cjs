const { spawnSync } = require("node:child_process");
const {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");

const root = join(__dirname, "..");
const preloadOutDir = join(root, "out", "preload");
const generatedOutDirNames = ["main", "shared", "preload"];

/**
 * @typedef {{
 *   code: string;
 *   fileName: string;
 *   map?: { toString(): string } | null;
 *   type: "chunk";
 * }} ViteChunkOutput
 * @typedef {{
 *   fileName: string;
 *   source: string | Uint8Array;
 *   type: "asset";
 * }} ViteAssetOutput
 * @typedef {ViteChunkOutput | ViteAssetOutput} ViteOutput
 */

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * @param {string} packageName
 * @param {...string} parts
 */
function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}

/**
 * @param {string} projectRoot
 * @param {string} outputDir
 */
function cleanGeneratedOutDir(projectRoot, outputDir) {
  const resolvedOutDir = resolve(outputDir);
  const expectedOutDirs = generatedOutDirNames.map((name) =>
    resolve(projectRoot, "out", name),
  );
  if (!expectedOutDirs.includes(resolvedOutDir)) {
    throw new Error(
      `Refusing to clean unexpected generated output: ${outputDir}`,
    );
  }
  assertRealGeneratedPath(projectRoot, resolvedOutDir);
  if (!existsSync(resolvedOutDir)) {
    return;
  }
  for (const entry of readdirSync(resolvedOutDir)) {
    removePath(resolve(resolvedOutDir, entry));
  }
}

/**
 * @param {string} projectRoot
 * @param {string} candidate
 * @param {{ exists?: typeof existsSync; lstat?: typeof lstatSync }} [options]
 */
function assertRealGeneratedPath(projectRoot, candidate, options = {}) {
  const exists = options.exists ?? existsSync;
  const lstat = options.lstat ?? lstatSync;
  const resolvedRoot = resolve(projectRoot);
  const resolvedCandidate = resolve(candidate);
  const child = relative(resolvedRoot, resolvedCandidate);
  if (child === "" || /^\.\.(?:[\\/]|$)/u.test(child) || isAbsolute(child)) {
    throw new Error(
      `Generated output must stay inside the project: ${candidate}`,
    );
  }
  let cursor = resolvedRoot;
  for (const part of child.split(/[\\/]/u)) {
    cursor = join(cursor, part);
    if (!exists(cursor)) return;
    if (lstat(cursor).isSymbolicLink()) {
      throw new Error(
        `Generated output path cannot contain symbolic links: ${cursor}`,
      );
    }
  }
}

/** @param {string} [projectRoot] */
function cleanElectronTypeScriptOutDirs(projectRoot = root) {
  cleanGeneratedOutDir(projectRoot, join(projectRoot, "out", "main"));
  cleanGeneratedOutDir(projectRoot, join(projectRoot, "out", "shared"));
}

function cleanPreloadOutDir() {
  cleanGeneratedOutDir(root, preloadOutDir);
}

/** @param {string} targetPath */
function removePath(targetPath) {
  const stat = lstatSync(targetPath);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of readdirSync(targetPath)) {
      removePath(resolve(targetPath, entry));
    }
    rmdirSync(targetPath);
    return;
  }
  unlinkSync(targetPath);
}

async function bundlePreload() {
  const { build } = await import("vite");
  const result = await build({
    build: {
      write: false,
    },
    configFile: "vite.preload.config.ts",
  });
  const outputs = Array.isArray(result)
    ? result.flatMap((item) => (isBuildOutput(item) ? item.output : []))
    : isBuildOutput(result)
      ? result.output
      : [];

  console.log(`writing preload bundle (${outputs.length} outputs)`);
  cleanPreloadOutDir();
  for (const output of outputs) {
    const targetPath = join(preloadOutDir, output.fileName);
    mkdirSync(dirname(targetPath), { recursive: true });
    if (output.type === "chunk") {
      writeFileSync(targetPath, output.code, "utf8");
      if (output.map) {
        writeFileSync(`${targetPath}.map`, output.map.toString(), "utf8");
      }
      continue;
    }
    writeFileSync(targetPath, output.source);
  }
}

/**
 * @param {unknown} value
 * @returns {value is { output: ViteOutput[] }}
 */
function isBuildOutput(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "output" in value &&
    Array.isArray(/** @type {{ output?: unknown }} */ (value).output)
  );
}

/**
 * @param {string[]} args
 * @returns {{ noCheck: boolean }}
 */
function parseArguments(args) {
  const unsupported = args.filter((argument) => argument !== "--noCheck");
  if (
    unsupported.length > 0 ||
    args.filter((argument) => argument === "--noCheck").length > 1
  ) {
    throw new Error(
      `Unsupported compile-electron arguments: ${args.join(" ") || "(none)"}`,
    );
  }
  return { noCheck: args.includes("--noCheck") };
}

/** @param {{ noCheck: boolean }} options */
function electronTypeScriptArguments(options) {
  return [
    "-p",
    "tsconfig.electron.json",
    ...(options.noCheck ? ["--noCheck"] : []),
  ];
}

/** @param {string[]} [args] */
async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  cleanElectronTypeScriptOutDirs();
  run(process.execPath, [
    nodeBin("typescript", "bin", "tsc"),
    ...electronTypeScriptArguments(options),
  ]);
  await bundlePreload();
  run(process.execPath, [
    nodeBin("vite", "bin", "vite.js"),
    "build",
    "--config",
    "vite.page-export.config.ts",
  ]);
}

module.exports = {
  assertRealGeneratedPath,
  cleanElectronTypeScriptOutDirs,
  electronTypeScriptArguments,
  parseArguments,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
