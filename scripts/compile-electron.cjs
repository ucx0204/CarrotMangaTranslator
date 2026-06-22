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
const { dirname, join, resolve } = require("node:path");

const root = join(__dirname, "..");
const preloadOutDir = join(root, "out", "preload");

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

function cleanPreloadOutDir() {
  const resolvedOutDir = resolve(preloadOutDir);
  const expectedOutDir = resolve(root, "out", "preload");
  if (resolvedOutDir !== expectedOutDir) {
    throw new Error(
      `Refusing to clean unexpected preload output: ${preloadOutDir}`,
    );
  }
  if (!existsSync(resolvedOutDir)) {
    return;
  }
  for (const entry of readdirSync(resolvedOutDir)) {
    removePath(resolve(resolvedOutDir, entry));
  }
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

async function main() {
  run(process.execPath, [
    nodeBin("typescript", "bin", "tsc"),
    "-p",
    "tsconfig.electron.json",
  ]);
  await bundlePreload();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
