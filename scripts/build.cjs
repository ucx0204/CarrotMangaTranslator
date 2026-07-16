const { join, resolve } = require("node:path");
const {
  existsSync,
  lstatSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} = require("node:fs");
const { spawnSync } = require("node:child_process");
const { prepareRuntimeAssets } = require("./prepare-runtime.cjs");

const root = join(__dirname, "..");
const rendererOutDir = join(root, "out", "renderer");

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    console.error(result.error);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/** @param {string} dir */
function cleanDirectoryContents(dir) {
  const resolvedDir = resolve(dir);
  const expectedDir = resolve(root, "out", "renderer");
  if (resolvedDir !== expectedDir) {
    throw new Error(`Refusing to clean unexpected renderer output: ${dir}`);
  }
  if (!existsSync(resolvedDir)) {
    return;
  }
  for (const entry of readdirSync(resolvedDir)) {
    removePath(resolve(resolvedDir, entry));
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

run(process.execPath, [nodeBin("typescript", "bin", "tsc"), "--noEmit"]);
run(process.execPath, [join(__dirname, "compile-electron.cjs")]);
cleanDirectoryContents(rendererOutDir);
run(process.execPath, [
  nodeBin("vite", "bin", "vite.js"),
  "build",
  "--config",
  "vite.renderer.config.ts",
]);
prepareRuntimeAssets({ root, outputDir: join(root, "out", "app-runtime") });
run(process.execPath, [join(__dirname, "bundle-openai-oauth-runtime.cjs")]);

/**
 * @param {string} packageName
 * @param {...string} parts
 */
function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}
