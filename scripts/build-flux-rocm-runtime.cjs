#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} = require("node:fs");
const { copyFile, mkdir, rm, writeFile } = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} = require("node:path");
const AdmZip = require("adm-zip");

const rootDir = resolve(__dirname, "..");
const rocmVersion = "7.2.1";
const pythonVersion = "3.12.7";
const workerFile = "flux-klein-sdcpp-worker.py";
const manifestFile = "mgt-flux-rocm-runtime.json";
const outputFileName = `mgt-flux-rocm-win-x64-rocm${rocmVersion}-py${pythonVersion}-sdcpp.zip`;
const pythonUrl = `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`;
const getPipUrl = "https://bootstrap.pypa.io/get-pip.py";
const rocmBaseUrl = `https://repo.radeon.com/rocm/windows/rocm-rel-${rocmVersion}`;
const rocmPackageUrls = [
  `${rocmBaseUrl}/rocm_sdk_core-${rocmVersion}-py3-none-win_amd64.whl`,
  `${rocmBaseUrl}/rocm_sdk_devel-${rocmVersion}-py3-none-win_amd64.whl`,
  `${rocmBaseUrl}/rocm_sdk_libraries_custom-${rocmVersion}-py3-none-win_amd64.whl`,
  `${rocmBaseUrl}/rocm-${rocmVersion}.tar.gz`
];
const buildPackages = [
  "scikit-build-core>=0.11.0",
  "cmake>=3.29.0",
  "ninja>=1.11.1",
  "packaging>=24.0",
  "setuptools>=69.0.0",
  "wheel>=0.43.0"
];
const fluxPackages = [
  "--no-build-isolation",
  "--no-cache-dir",
  "--force-reinstall",
  "stable-diffusion-cpp-python",
  "huggingface_hub>=0.36.0",
  "pillow>=10.0.0"
];
const windowsMsvcCompilerTarget = "x86_64-pc-windows-msvc";
const windowsDynamicRuntimeLibs = ["msvcrt.lib", "vcruntime.lib", "ucrt.lib", "oldnames.lib"];

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(message);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workDir = resolve(args["work-dir"] || join(rootDir, ".tmp", "flux-rocm-runtime-build", stamp));
  const runtimeDir = resolve(args["runtime-dir"] || join(workDir, "runtime"));
  const downloadsDir = join(workDir, "downloads");
  const logsDir = join(workDir, "logs");
  const outputPath = resolve(args.out || join(rootDir, "dist", "runtime", outputFileName));
  const logPath = join(logsDir, "build.log");
  const envPath = join(logsDir, "environment.json");
  const keepWork = Boolean(args["keep-work"]);
  const force = Boolean(args.force);
  const logger = createLogger(logPath);

  try {
    logger.line(`MGT Flux ROCm prebuilt runtime build started at ${new Date().toISOString()}`);
    logger.line(`workDir=${workDir}`);
    logger.line(`runtimeDir=${runtimeDir}`);
    logger.line(`outputPath=${outputPath}`);
    await mkdir(logsDir, { recursive: true });
    await mkdir(downloadsDir, { recursive: true });
    await mkdir(dirname(outputPath), { recursive: true });

    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error("This runtime builder must be run on Windows x64.");
    }
    if (existsSync(outputPath) && !force) {
      throw new Error(`${outputPath} already exists. Use --force to overwrite it.`);
    }

    const nativeBuildEnv = resolveWindowsNativeBuildEnv();
    if (!nativeBuildEnv) {
      throw new Error(formatWindowsNativeBuildToolsMissingMessage());
    }
    const gpuTargets = resolveGpuTargets(args);
    await writeFile(envPath, `${JSON.stringify(snapshotEnvironment(nativeBuildEnv, gpuTargets), null, 2)}\n`, "utf8");
    logger.line(`environment snapshot: ${envPath}`);
    logger.line(`Windows SDK: ${nativeBuildEnv.sdkVersion || "unknown"}`);
    logger.line(`GPU targets: ${gpuTargets || "(not set)"}`);
    if (!gpuTargets) {
      logger.line("WARNING: GPU_TARGETS/AMDGPU_TARGETS is not set. The wheel may only support the builder default target.");
    }

    if (force) {
      await rm(runtimeDir, { recursive: true, force: true });
    }
    await mkdir(runtimeDir, { recursive: true });
    const pythonDir = join(runtimeDir, "bootstrap-python", `python-${pythonVersion}`);
    const pythonExe = join(pythonDir, "python.exe");
    const packageDir = join(runtimeDir, "p");
    await rm(packageDir, { recursive: true, force: true });
    await mkdir(packageDir, { recursive: true });

    await prepareEmbeddedPython({ pythonDir, pythonExe, packageDir, downloadsDir, logger });
    const installEnv = buildRuntimeEnv(runtimeDir, packageDir, nativeBuildEnv, gpuTargets);
    await run(pythonExe, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], { env: installEnv, logger });
    await run(pythonExe, ["-m", "pip", "install", "--upgrade", ...buildPackages], { env: installEnv, logger });
    await run(pythonExe, ["-m", "pip", "install", "--target", packageDir, ...rocmPackageUrls], { env: installEnv, logger });
    await run(pythonExe, ["-m", "pip", "install", "--target", packageDir, ...fluxPackages], { env: installEnv, logger });

    const workerSource = join(rootDir, "src", "main", "runtime", workerFile);
    if (!isFile(workerSource)) {
      throw new Error(`${workerFile} was not found: ${workerSource}`);
    }
    await copyFile(workerSource, join(runtimeDir, workerFile));
    await verifyRuntime({ pythonExe, packageDir, env: installEnv, logger });
    await writeRuntimeManifest({ runtimeDir, gpuTargets, nativeBuildEnv, logger });
    await createRuntimeZip({ runtimeDir, outputPath, logger });
    const sha256 = sha256File(outputPath);
    const sidecar = {
      file: basename(outputPath),
      sha256,
      bytes: statSync(outputPath).size,
      createdAt: new Date().toISOString(),
      rocmVersion,
      pythonVersion,
      gpuTargets: gpuTargets ? gpuTargets.split(";") : []
    };
    await writeFile(`${outputPath}.sha256`, `${sha256}  ${basename(outputPath)}\n`, "utf8");
    await writeFile(`${outputPath}.json`, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
    logger.line(`ZIP: ${outputPath}`);
    logger.line(`SHA256: ${sha256}`);
    logger.line("MGT Flux ROCm prebuilt runtime build finished successfully.");
  } catch (error) {
    logger.line("");
    logger.line("BUILD FAILED");
    logger.line(error?.stack || error?.message || String(error));
    logger.line(`Log file: ${logPath}`);
    throw error;
  } finally {
    logger.close();
    if (!keepWork && !process.exitCode) {
      // Keep work dir by default during early runtime work; deleting it makes build failures hard to inspect.
      // Users can remove .tmp/flux-rocm-runtime-build after uploading the ZIP.
    }
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function createLogger(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "a" });
  return {
    line(text) {
      const line = `[${new Date().toISOString()}] ${text}`;
      console.log(line);
      stream.write(`${line}\n`);
    },
    raw(text) {
      process.stdout.write(text);
      stream.write(text);
    },
    close() {
      stream.end();
    }
  };
}

async function prepareEmbeddedPython({ pythonDir, pythonExe, packageDir, downloadsDir, logger }) {
  if (!isFile(pythonExe)) {
    await rm(pythonDir, { recursive: true, force: true });
    await mkdir(pythonDir, { recursive: true });
    const zipPath = join(downloadsDir, basename(new URL(pythonUrl).pathname));
    await downloadFile(pythonUrl, zipPath, logger);
    extractZipSafely(zipPath, pythonDir);
  }
  sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);
  ensureEmbeddedPythonPackagePath(pythonExe, packageDir);
  const getPipPath = join(downloadsDir, "get-pip.py");
  await downloadFile(getPipUrl, getPipPath, logger);
  await run(pythonExe, [getPipPath], {
    env: {
      ...process.env,
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1"
    },
    logger
  });
}

function buildRuntimeEnv(runtimeDir, packageDir, nativeBuildEnv, gpuTargets) {
  const rocmPaths = resolveWindowsRocmSdkPaths(packageDir);
  const pathEntries = [
    join(runtimeDir, "bootstrap-python", `python-${pythonVersion}`),
    join(runtimeDir, "bootstrap-python", `python-${pythonVersion}`, "Scripts"),
    packageDir,
    join(packageDir, "Scripts"),
    join(packageDir, "rocm", "bin"),
    join(packageDir, "rocm_sdk", "bin"),
    join(packageDir, "Library", "bin"),
    join(packageDir, "_rocm_sdk_core", "bin"),
    join(packageDir, "_rocm_sdk_core", "lib", "llvm", "bin"),
    join(packageDir, "_rocm_sdk_devel", "bin"),
    join(packageDir, "_rocm_sdk_devel", "lib", "llvm", "bin"),
    join(packageDir, "_rocm_sdk_libraries_custom", "bin"),
    join(packageDir, "_rocm_sdk_libraries_custom", "bin", "hipblaslt"),
    join(packageDir, "_rocm_sdk_libraries_custom", "bin", "hipblaslt", "library")
  ];
  const cmakeArgs = [
    `-DCMAKE_C_COMPILER:FILEPATH=${toCmakePath(rocmPaths.clang)}`,
    `-DCMAKE_CXX_COMPILER:FILEPATH=${toCmakePath(rocmPaths.clangxx)}`,
    `-DCMAKE_RC_COMPILER:FILEPATH=${toCmakePath(rocmPaths.llvmRc)}`,
    isFile(rocmPaths.llvmMt) ? `-DCMAKE_MT:FILEPATH=${toCmakePath(rocmPaths.llvmMt)}` : "",
    nativeBuildEnv.sdkVersion ? `-DCMAKE_SYSTEM_VERSION=${nativeBuildEnv.sdkVersion}` : "",
    nativeBuildEnv.sdkVersion ? `-DCMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION=${nativeBuildEnv.sdkVersion}` : "",
    `-DCMAKE_C_COMPILER_TARGET=${windowsMsvcCompilerTarget}`,
    `-DCMAKE_CXX_COMPILER_TARGET=${windowsMsvcCompilerTarget}`,
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL",
    `-DCMAKE_C_STANDARD_LIBRARIES:STRING=${windowsDynamicRuntimeLibs.join(";")}`,
    `-DCMAKE_CXX_STANDARD_LIBRARIES:STRING=${windowsDynamicRuntimeLibs.join(";")}`,
    "-DCMAKE_TRY_COMPILE_CONFIGURATION=Release",
    "-DSD_HIPBLAS=ON",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    gpuTargets ? `-DGPU_TARGETS=${gpuTargets}` : "",
    gpuTargets ? `-DAMDGPU_TARGETS=${gpuTargets}` : ""
  ].filter(Boolean);
  const env = {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: packageDir,
    TMP: join(runtimeDir, "t"),
    TEMP: join(runtimeDir, "t"),
    PATH: mergePathList(nativeBuildEnv.pathEntries, pathEntries, process.env.PATH),
    INCLUDE: mergePathList(process.env.INCLUDE, nativeBuildEnv.includePaths),
    LIB: mergePathList(process.env.LIB, nativeBuildEnv.libPaths),
    LIBPATH: mergePathList(process.env.LIBPATH, nativeBuildEnv.libPaths),
    CMAKE_ARGS: mergeWords(process.env.CMAKE_ARGS, cmakeArgs.join(" ")),
    CFLAGS: mergeWords(process.env.CFLAGS, `--target=${windowsMsvcCompilerTarget}`),
    CXXFLAGS: mergeWords(process.env.CXXFLAGS, `--target=${windowsMsvcCompilerTarget}`),
    LDFLAGS: mergeWords(process.env.LDFLAGS, windowsDynamicRuntimeLibs.join(" ")),
    FORCE_CMAKE: "1",
    CMAKE_GENERATOR: process.env.CMAKE_GENERATOR || "Ninja",
    CC: process.env.CC || rocmPaths.clang,
    CXX: process.env.CXX || rocmPaths.clangxx,
    RC: process.env.RC || rocmPaths.llvmRc,
    ROCM_PATH: process.env.ROCM_PATH || rocmPaths.coreRoot,
    HIP_PATH: process.env.HIP_PATH || rocmPaths.coreRoot,
    CMAKE_PREFIX_PATH: mergePathList(process.env.CMAKE_PREFIX_PATH, [rocmPaths.coreRoot, rocmPaths.develRoot, rocmPaths.librariesRoot])
  };
  if (gpuTargets) {
    env.GPU_TARGETS = gpuTargets;
    env.AMDGPU_TARGETS = gpuTargets;
  }
  mkdirSync(env.TMP, { recursive: true });
  return env;
}

async function verifyRuntime({ pythonExe, packageDir, env, logger }) {
  const script = [
    "import importlib",
    "for name in ['stable_diffusion_cpp','PIL','huggingface_hub']:",
    "    importlib.import_module(name)",
    "print('ok')"
  ].join("\n");
  await run(pythonExe, ["-c", script], { env, logger });
  await run(pythonExe, ["-m", "pip", "show", "stable-diffusion-cpp-python"], { env, logger });
  if (!isDirectory(join(packageDir, "stable_diffusion_cpp"))) {
    throw new Error(`stable_diffusion_cpp package is missing from ${packageDir}`);
  }
}

async function writeRuntimeManifest({ runtimeDir, gpuTargets, nativeBuildEnv, logger }) {
  const manifest = {
    schemaVersion: 1,
    kind: "mgt-flux-rocm-prebuilt-runtime",
    backend: "python-rocm",
    runtime: "stable-diffusion-cpp-python",
    rocmVersion,
    pythonVersion,
    platform: "win32",
    arch: "x64",
    packageDir: "p",
    pythonPath: `bootstrap-python/python-${pythonVersion}/python.exe`,
    worker: workerFile,
    gpuTargets: gpuTargets ? gpuTargets.split(";") : [],
    windowsSdkVersion: nativeBuildEnv.sdkVersion || null,
    createdAt: new Date().toISOString(),
    gitRevision: readGitRevision()
  };
  await writeFile(join(runtimeDir, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  logger.line(`manifest written: ${join(runtimeDir, manifestFile)}`);
}

async function createRuntimeZip({ runtimeDir, outputPath, logger }) {
  rmSync(outputPath, { force: true });
  const zip = new AdmZip();
  zip.addLocalFolder(runtimeDir);
  zip.writeZip(outputPath);
  logger.line(`zip created: ${outputPath} (${formatBytes(statSync(outputPath).size)})`);
}

function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    options.logger.line(`> ${command} ${args.map(quoteArg).join(" ")}`);
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd || rootDir,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => options.logger.raw(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => options.logger.raw(chunk.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

async function downloadFile(url, outputPath, logger) {
  if (isFile(outputPath) && statSync(outputPath).size > 0) {
    logger.line(`download cache: ${outputPath}`);
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  logger.line(`download: ${url}`);
  await new Promise((resolveDownload, reject) => {
    const file = createWriteStream(outputPath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GET ${url} failed with ${response.statusCode}`));
        return;
      }
      const total = Number(response.headers["content-length"] || 0);
      let received = 0;
      let lastLogAt = Date.now();
      response.on("data", (chunk) => {
        received += chunk.byteLength;
        const now = Date.now();
        if (now - lastLogAt > 1500) {
          lastLogAt = now;
          logger.line(`download progress: ${basename(outputPath)} ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""}`);
        }
      });
      response.pipe(file);
      file.on("finish", () => file.close(resolveDownload));
      file.on("error", reject);
      response.on("error", reject);
    }).on("error", reject);
  });
  logger.line(`download complete: ${outputPath} (${formatBytes(statSync(outputPath).size)})`);
}

function extractZipSafely(archivePath, outputDir) {
  const zip = new AdmZip(archivePath);
  const root = resolve(outputDir);
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const entryName = item.entryName.replace(/^([/\\])+/, "");
    if (!entryName || entryName.startsWith("..") || isAbsolute(entryName)) {
      throw new Error(`${basename(archivePath)} contains unsafe path: ${item.entryName}`);
    }
    const destination = resolve(root, entryName);
    if (!isPathInside(destination, root)) {
      throw new Error(`${basename(archivePath)} contains unsafe path: ${item.entryName}`);
    }
    zip.extractEntryTo(item, root, true, true);
  }
}

function sanitizeStandaloneEmbeddedPythonPathFile(outputDir) {
  const pthName = readdirSync(outputDir).find((name) => /^python\d+._pth$/i.test(name)) || "";
  if (!pthName) {
    return;
  }
  const pthPath = join(outputDir, pthName);
  const text = readFileSync(pthPath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "#import site" && line.trim() !== "import site")
    .filter((line) => line.trim());
  lines.push("import site");
  writeFileSync(pthPath, `${lines.join("\n")}\n`, "utf8");
}

function ensureEmbeddedPythonPackagePath(pythonPath, packageDir) {
  const pythonDir = dirname(resolve(pythonPath));
  const pthName = readdirSync(pythonDir).find((name) => /^python\d+._pth$/i.test(name)) || "";
  if (!pthName) {
    return;
  }
  const pthPath = join(pythonDir, pthName);
  const normalizedPackageDir = resolve(packageDir);
  const text = readFileSync(pthPath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== normalizedPackageDir)
    .map((line) => line.trim() === "#import site" ? "import site" : line);
  const importSiteIndex = lines.findIndex((line) => line.trim() === "import site");
  if (importSiteIndex === -1) {
    lines.push(normalizedPackageDir, "import site");
  } else {
    lines.splice(importSiteIndex, 0, normalizedPackageDir);
  }
  writeFileSync(pthPath, `${lines.filter((line, index, array) => index < array.length - 1 || line.trim()).join("\n")}\n`, "utf8");
}

function resolveWindowsRocmSdkPaths(packageDir) {
  const coreRoot = join(packageDir, "_rocm_sdk_core");
  const llvmBin = join(coreRoot, "lib", "llvm", "bin");
  return {
    coreRoot,
    develRoot: join(packageDir, "_rocm_sdk_devel"),
    librariesRoot: join(packageDir, "_rocm_sdk_libraries_custom"),
    clang: join(llvmBin, "clang.exe"),
    clangxx: join(llvmBin, "clang++.exe"),
    llvmRc: join(llvmBin, "llvm-rc.exe"),
    llvmMt: join(llvmBin, "llvm-mt.exe")
  };
}

function resolveWindowsNativeBuildEnv() {
  const sdk = resolveWindowsSdkLayout();
  const msvc = resolveMsvcToolsLayout();
  const libPaths = uniqueExistingDirs([
    ...splitPathList(process.env.LIB),
    ...(sdk ? [sdk.umLibPath, sdk.ucrtLibPath] : []),
    ...(msvc ? [msvc.libPath] : [])
  ]);
  const includePaths = uniqueExistingDirs([
    ...splitPathList(process.env.INCLUDE),
    ...(sdk ? sdk.includePaths : []),
    ...(msvc ? [msvc.includePath] : [])
  ]);
  const pathEntries = uniqueExistingDirs([
    ...(sdk?.binPath ? [sdk.binPath] : []),
    ...(msvc?.binPath ? [msvc.binPath] : []),
    ...splitPathList(process.env.PATH)
  ]);
  const hasWindowsSdkLibs = ["kernel32.lib", "user32.lib", "gdi32.lib", "shell32.lib", "ole32.lib", "uuid.lib", "advapi32.lib"]
    .every((file) => pathListContainsFile(libPaths, file));
  const hasUcrtLibs = pathListContainsFile(libPaths, "ucrt.lib");
  const hasMsvcLibs =
    pathListContainsFile(libPaths, "oldnames.lib") &&
    pathListContainsFile(libPaths, "vcruntime.lib") &&
    (pathListContainsFile(libPaths, "msvcrt.lib") || pathListContainsFile(libPaths, "msvcrtd.lib"));
  if (!hasWindowsSdkLibs || !hasUcrtLibs || !hasMsvcLibs) {
    return null;
  }
  return { sdkVersion: sdk?.version, pathEntries, includePaths, libPaths };
}

function formatWindowsNativeBuildToolsMissingMessage() {
  return [
    "Windows SDK and Microsoft C++ Build Tools were not found.",
    "Install Visual Studio 2022 Build Tools with Desktop development with C++ and a Windows 10/11 SDK.",
    "If they are already installed, run from Developer Command Prompt or set MANGA_TRANSLATOR_WINDOWS_KITS_ROOT / MANGA_TRANSLATOR_MSVC_TOOLS_ROOT."
  ].join(" ");
}

function resolveWindowsSdkLayout() {
  const roots = uniquePaths([
    process.env.MANGA_TRANSLATOR_WINDOWS_KITS_ROOT,
    process.env.MGT_WINDOWS_KITS_ROOT,
    process.env.WindowsSdkDir,
    process.env.UniversalCRTSdkDir,
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Windows Kits", "10") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Windows Kits", "10") : ""
  ]);
  for (const root of roots) {
    const libRoot = join(root, "Lib");
    const includeRoot = join(root, "Include");
    const versions = readChildDirectories(libRoot).sort(compareVersionDesc);
    for (const version of versions) {
      const umLibPath = join(libRoot, version, "um", "x64");
      const ucrtLibPath = join(libRoot, version, "ucrt", "x64");
      if (!isFile(join(umLibPath, "kernel32.lib")) || !isDirectory(ucrtLibPath)) {
        continue;
      }
      const includePaths = ["ucrt", "shared", "um", "winrt", "cppwinrt"]
        .map((name) => join(includeRoot, version, name))
        .filter(isDirectory);
      const binPath = join(root, "bin", version, "x64");
      return { root, version, umLibPath, ucrtLibPath, includePaths, binPath: isDirectory(binPath) ? binPath : undefined };
    }
  }
  return null;
}

function resolveMsvcToolsLayout() {
  const directRoots = uniquePaths([
    process.env.MANGA_TRANSLATOR_MSVC_TOOLS_ROOT,
    process.env.MGT_MSVC_TOOLS_ROOT,
    process.env.VCToolsInstallDir
  ]);
  for (const root of directRoots) {
    const layout = toMsvcToolsLayout(root);
    if (layout) {
      return layout;
    }
  }
  const versionRoots = [];
  if (process.env.VCINSTALLDIR) {
    versionRoots.push(join(process.env.VCINSTALLDIR, "Tools", "MSVC"));
  }
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    for (const year of ["2022", "2019"]) {
      for (const edition of ["BuildTools", "Community", "Professional", "Enterprise"]) {
        versionRoots.push(join(programFiles, "Microsoft Visual Studio", year, edition, "VC", "Tools", "MSVC"));
      }
    }
  }
  for (const versionRoot of uniquePaths(versionRoots)) {
    const versions = readChildDirectories(versionRoot).sort(compareVersionDesc);
    for (const version of versions) {
      const layout = toMsvcToolsLayout(join(versionRoot, version), version);
      if (layout) {
        return layout;
      }
    }
  }
  return null;
}

function toMsvcToolsLayout(root, version) {
  const libPath = join(root, "lib", "x64");
  const includePath = join(root, "include");
  if (!isFile(join(libPath, "oldnames.lib")) || !isDirectory(includePath)) {
    return null;
  }
  const binPath = join(root, "bin", "Hostx64", "x64");
  return { root, version, libPath, includePath, binPath: isDirectory(binPath) ? binPath : undefined };
}

function resolveGpuTargets(args) {
  const value = args["gpu-targets"] ||
    process.env.MANGA_TRANSLATOR_AMDGPU_TARGETS ||
    process.env.MGT_AMDGPU_TARGETS ||
    process.env.AMDGPU_TARGETS ||
    process.env.GPU_TARGETS ||
    "";
  return String(value)
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(";") || null;
}

function snapshotEnvironment(nativeBuildEnv, gpuTargets) {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    cwd: process.cwd(),
    rootDir,
    rocmVersion,
    pythonVersion,
    gpuTargets: gpuTargets ? gpuTargets.split(";") : [],
    env: {
      ROCM_PATH: process.env.ROCM_PATH || null,
      HIP_PATH: process.env.HIP_PATH || null,
      GPU_TARGETS: process.env.GPU_TARGETS || null,
      AMDGPU_TARGETS: process.env.AMDGPU_TARGETS || null,
      CMAKE_GENERATOR: process.env.CMAKE_GENERATOR || null
    },
    nativeBuildEnv
  };
}

function readGitRevision() {
  try {
    const { execFileSync } = require("node:child_process");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function quoteArg(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function isPathInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function splitPathList(value) {
  return String(value || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergePathList(...values) {
  const entries = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      entries.push(...value);
    } else {
      entries.push(...splitPathList(value));
    }
  }
  return uniquePaths(entries).join(delimiter);
}

function mergeWords(...values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function uniqueExistingDirs(paths) {
  return uniquePaths(paths).filter(isDirectory);
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const rawPath of paths) {
    const value = String(rawPath || "").trim();
    if (!value) {
      continue;
    }
    const normalized = resolve(value);
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function readChildDirectories(root) {
  try {
    return readdirSync(root)
      .map((name) => ({ name, path: join(root, name) }))
      .filter((entry) => isDirectory(entry.path))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compareVersionDesc(left, right) {
  return compareVersionStrings(right, left);
}

function compareVersionStrings(left, right) {
  const leftParts = left.split(/[^\d]+/).filter(Boolean).map(Number);
  const rightParts = right.split(/[^\d]+/).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.localeCompare(right);
}

function pathListContainsFile(paths, fileName) {
  return paths.some((dir) => isFile(join(dir, fileName)));
}

function isDirectory(pathValue) {
  try {
    return statSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}

function isFile(pathValue) {
  try {
    return statSync(pathValue).isFile();
  } catch {
    return false;
  }
}

function toCmakePath(pathValue) {
  return resolve(pathValue).replace(/\\/g, "/");
}
