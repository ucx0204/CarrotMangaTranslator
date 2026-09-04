const { join, resolve } = require("node:path");
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} = require("node:fs");
const { spawnSync } = require("node:child_process");
const { assertRealGeneratedPath } = require("./compile-electron.cjs");
const { prepareRuntimeAssets } = require("./prepare-runtime.cjs");
const { stageOnnxRuntimeNode } = require("./stage-onnxruntime-node.cjs");
const {
  createElectronCompileCacheStep,
  createOnnxRuntimeCacheStep,
  createRendererBundleCacheStep,
  createRuntimeAssetsCacheStep,
  runCachedBuildStep,
} = require("./dev-build-cache.cjs");

const root = join(__dirname, "..");
const rendererOutDir = join(root, "out", "renderer");
const skipTypecheck = process.argv.includes("--skip-typecheck");
const reuseVerifiedOutputs = process.argv.includes("--reuse-verified-outputs");
const supportedArguments = new Set([
  "--skip-typecheck",
  "--reuse-verified-outputs",
]);
const unsupportedArgs = process.argv
  .slice(2)
  .filter((argument) => !supportedArguments.has(argument));

if (
  unsupportedArgs.length > 0 ||
  [...supportedArguments].some(
    (argument) =>
      process.argv.filter((candidate) => candidate === argument).length > 1,
  )
) {
  throw new Error(`Unsupported build arguments: ${unsupportedArgs.join(" ")}`);
}

/** @type {Array<{ name: string; status: "built" | "skipped"; reason: string }>} */
const buildStepResults = [];

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

/**
 * @param {string} name
 * @param {() => import("./dev-build-cache.cjs").CachedBuildStep} createStep
 * @param {() => void} build
 */
function runBuildStep(name, createStep, build) {
  const result = reuseVerifiedOutputs
    ? runCachedBuildStep(createStep(), build)
    : runUncachedBuildStep(build);
  buildStepResults.push({ name, ...result });
  console.log(`[build-cache] ${name}: ${result.status} (${result.reason})`);
}

/** @param {() => void} build */
function runUncachedBuildStep(build) {
  build();
  return /** @type {const} */ ({
    status: "built",
    reason: "cache disabled",
  });
}

/** @param {string} dir */
function cleanDirectoryContents(dir) {
  const resolvedDir = resolve(dir);
  const expectedDir = resolve(root, "out", "renderer");
  if (resolvedDir !== expectedDir) {
    throw new Error(`Refusing to clean unexpected renderer output: ${dir}`);
  }
  assertRealGeneratedPath(root, resolvedDir);
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

// Refuse a redirected output root before compile-electron or any recursive
// cleanup can touch generated directories.
assertRealGeneratedPath(root, join(root, "out"));

if (skipTypecheck) {
  console.log("> reusing the successful general and Electron check typechecks");
} else {
  run(process.execPath, [
    nodeBin("typescript", "bin", "tsc"),
    "-p",
    "tsconfig.typecheck.json",
  ]);
}
runBuildStep(
  "electron",
  () =>
    createElectronCompileCacheStep(root, {
      cacheFile: join(root, ".tmp", "check-cache", "build", "electron.json"),
      additionalInputFiles: [join(root, "scripts", "build.cjs")],
    }),
  () =>
    run(process.execPath, [
      join(__dirname, "compile-electron.cjs"),
      ...(skipTypecheck ? ["--noCheck"] : []),
    ]),
);
runBuildStep(
  "renderer",
  () => createRendererBundleCacheStep(root),
  () => {
    cleanDirectoryContents(rendererOutDir);
    run(process.execPath, [
      nodeBin("vite", "bin", "vite.js"),
      "build",
      "--config",
      "vite.renderer.config.ts",
    ]);
    // 빌트인 폰트는 fonts.css에서 mgt-font:///<rel> 커스텀 스킴으로 로드한다. Vite는
    // 이 절대 URL을 외부 자산으로 취급해 해시 복사본을 내보내지 않으므로, 패키징 후
    // 메인 프로세스의 mgt-font 핸들이 Node fs(asar 인식)로 읽을 수 있도록 원본 폰트
    // 트리를 out/renderer/assets/fonts 아래에 그대로 복사한다(#53 OTS zero-length).
    copyFontAssets(root);
  },
);
const runtimeOutputDir = join(root, "out", "app-runtime");
runBuildStep(
  "runtime-assets",
  () =>
    createRuntimeAssetsCacheStep(root, runtimeOutputDir, {
      additionalInputFiles: [join(root, "scripts", "build.cjs")],
      cacheFile: join(
        root,
        ".tmp",
        "check-cache",
        "build",
        "runtime-assets.json",
      ),
      cacheKey: "production-runtime-assets",
      excludedOutputDirectories: [join(runtimeOutputDir, "o")],
    }),
  () => prepareRuntimeAssets({ root, outputDir: runtimeOutputDir }),
);
runBuildStep(
  "onnx-runtime",
  () => createOnnxRuntimeCacheStep(root, runtimeOutputDir),
  () => stageOnnxRuntimeNode({ root }),
);
console.log(
  `[check-metadata] ${JSON.stringify({
    stage: "build",
    cacheHit:
      reuseVerifiedOutputs &&
      buildStepResults.every((result) => result.status === "skipped"),
    buildSteps: buildStepResults,
  })}`,
);

/**
 * @param {string} packageName
 * @param {...string} parts
 */
function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}

/**
 * 빌트인 @font-face 자산(원본 파일명, 해시 없음)을 Vite 출력 트리 아래에
 * 복사한다. out/renderer/** 는 asar에 패키짭되며, 메인 프로세스의 mgt-font 핸들이
 * resolveBundledFontFilePath 경로를 Node fs로 읽는다(#53).
 *
 * @param {string} root
 */
function copyFontAssets(root) {
  const sourceDir = join(root, "src", "renderer", "src", "assets", "fonts");
  const targetDir = join(root, "out", "renderer", "assets", "fonts");
  if (!existsSync(sourceDir)) {
    throw new Error(`Bundled font source directory not found: ${sourceDir}`);
  }
  // Node v24 의 fs.cpSync(recursive) 가 한글 경로(망가번역기) 소스에서
  // 크래시(0xC0000409 STATUS_STACK_BUFFER_OVERRUN)하므로 동일 결과를 주는
  // 수동 재귀 복사로 대체한다(#53).
  copyTree(sourceDir, targetDir);
  console.log(`> copy bundled font assets -> out/renderer/assets/fonts`);
}

/**
 * fs.cpSync(recursive) 대신 사용하는 수동 재귀 복사. Node v24/Windows 에서
 * 한글 경로 소스의 cpSync 가 크래시(0xC0000409)하므로 readdirSync +
 * mkdirSync + copyFileSync 조합으로 동일 결과를 얻는다(#53).
 *
 * @param {string} src
 * @param {string} dst
 */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
  }
}
