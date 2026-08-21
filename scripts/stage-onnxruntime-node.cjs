// @ts-check

const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");
const { assertRealGeneratedPath } = require("./compile-electron.cjs");

const root = resolve(__dirname, "..");
const outputRoot = join(root, "out", "app-runtime", "o");

function stageOnnxRuntimeNode() {
  assertRealGeneratedPath(root, outputRoot);
  if (existsSync(outputRoot)) removePath(outputRoot);
  mkdirSync(join(outputRoot, "b"), { recursive: true });
  mkdirSync(join(outputRoot, "c"), { recursive: true });

  const nodePackageRoot = join(root, "node_modules", "onnxruntime-node");
  const commonPackageRoot = join(root, "node_modules", "onnxruntime-common");
  const nodePackage = readJson(join(nodePackageRoot, "package.json"));
  const target = resolveTargetRuntime();
  for (const entry of realFiles(join(nodePackageRoot, "dist"), ".js")) {
    const source = join(nodePackageRoot, "dist", entry);
    let code = readFileSync(source, "utf8").replaceAll(
      'require("onnxruntime-common")',
      'require("./c")',
    );
    if (entry === "binding.js") {
      const original =
        "require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)";
      if (!code.includes(original)) {
        throw new Error("onnxruntime-node native binding contract drifted");
      }
      code = code.replace(original, 'require("./b/onnxruntime_binding.node")');
    }
    code = code.replace(/^\/\/# sourceMappingURL=.*$/gmu, "");
    writeFileSync(join(outputRoot, entry), code, "utf8");
  }
  for (const entry of realFiles(
    join(commonPackageRoot, "dist", "cjs"),
    ".js",
  )) {
    copyRealFile(
      join(commonPackageRoot, "dist", "cjs", entry),
      join(outputRoot, "c", entry),
    );
  }
  copyRealFile(
    join(commonPackageRoot, "dist", "cjs", "package.json"),
    join(outputRoot, "c", "package.json"),
  );
  for (const entry of realFiles(target.binarySource)) {
    copyRealFile(
      join(target.binarySource, entry),
      join(outputRoot, "b", entry),
    );
  }
  writeFileSync(
    join(outputRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "mgt-onnxruntime-node-runtime",
        version: nodePackage.version,
        license: nodePackage.license,
        main: "index.js",
        platform: target.platform,
        arch: target.arch,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `> staged onnxruntime-node ${nodePackage.version} -> out/app-runtime/o (${target.platform}/${target.arch})`,
  );
}

function resolveTargetRuntime() {
  const mac =
    process.platform === "darwin" ||
    process.env.MGT_TARGET_PLATFORM === "darwin";
  const platform = mac ? "darwin" : "win32";
  const arch = mac ? "arm64" : "x64";
  return {
    platform,
    arch,
    binarySource: join(
      root,
      "node_modules",
      "onnxruntime-node",
      "bin",
      "napi-v6",
      platform,
      arch,
    ),
  };
}

/** @param {string} directory @param {string} [extension] */
function realFiles(directory, extension) {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Runtime source directory is invalid: ${directory}`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && (!extension || entry.name.endsWith(extension)),
    )
    .map((entry) => entry.name)
    .sort();
}

/** @param {string} source @param {string} target */
function copyRealFile(source, target) {
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error(`Runtime source file is invalid: ${source}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

/** @param {string} path */
function readJson(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object") {
    throw new Error(`Runtime package metadata is invalid: ${basename(path)}`);
  }
  return value;
}

/** @param {string} targetPath */
function removePath(targetPath) {
  const metadata = lstatSync(targetPath);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    for (const entry of readdirSync(targetPath)) {
      removePath(join(targetPath, entry));
    }
    rmdirSync(targetPath);
    return;
  }
  unlinkSync(targetPath);
}

if (require.main === module) stageOnnxRuntimeNode();

module.exports = { resolveTargetRuntime, stageOnnxRuntimeNode };
