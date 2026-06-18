import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ensureFluxWorkerLaunch,
  parsePipDownloadProgressLine,
  resolveFluxPythonRuntimeLayout,
  resolveWindowsNativeBuildEnv,
} from "../src/main/inpainting/fluxAssets";
import {
  CUDA_REDIST_MANIFEST_URL,
  DEFAULT_AMD_GPU_TARGETS,
  FLUX_CUDA_RUNTIME_MARKER,
  FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST,
  FLUX_SDCPP_WORKER,
  FLUX_ZLUDA_SUPPORT_RUNTIME_DIR,
} from "../src/main/inpainting/fluxAssets/constants";
import { ensureManagedFluxRunner } from "../src/main/inpainting/fluxAssets/cudaRuntime";
import { resolveFluxRunnerDirForComputeCapability } from "../src/main/inpainting/fluxAssets/cudaRuntime";
import {
  resolveFluxPythonWorkerFile,
  ensureFluxPythonWorker,
} from "../src/main/inpainting/fluxAssets/pythonRuntimeLayout";
import {
  resolveFluxRocmPrebuiltRuntimeUrl,
  resolvePythonBuildPackages,
  resolvePythonFluxPackages,
  resolvePythonRuntimeInstallBatches,
  shouldAllowFluxRocmSourceBuildFallback,
  shouldUsePrebuiltFluxRocmRuntime,
} from "../src/main/inpainting/fluxAssets/manifests";
import { resolveDefaultFluxRunRootDir } from "../src/main/inpainting/fluxEngine";
import {
  buildFluxWorkerResponseError,
  buildRuntimePathEnv,
  sanitizeFluxRuntimeStderr,
} from "../src/main/inpainting/fluxWorker";

const tempDirs: string[] = [];
const repoRoot = join(__dirname, "..");
const AdmZip = require("adm-zip");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CUDA_PATH_V12_9;
  delete process.env.MGT_FLUX_ALLOW_SYSTEM_CUDA;
  delete process.env.MGT_FLUX_KLEIN_EXE;
  delete process.env.MGT_FLUX_KLEIN_TOOLS_DIR;
  delete process.env.MGT_FLUX_DISABLE_REMOTE_RUNNER_DOWNLOAD;
  delete process.env.MGT_FLUX_KLEIN_RUNNER_BASE_URL;
  delete process.env.MGT_FLUX_KLEIN_RUNNER_SHA256_SM86;
  delete process.env.CUDA_PATH;
  delete process.env.ROCM_PATH;
  delete process.env.HIP_PATH;
  delete process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_DIR;
  delete process.env.MGT_FLUX_ROCM_RUNTIME_DIR;
  delete process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_ARCHIVE_URL;
  delete process.env.MGT_FLUX_ROCM_RUNTIME_ARCHIVE_URL;
  delete process.env.MANGA_TRANSLATOR_FLUX_ROCM_USE_PREBUILT;
  delete process.env.MGT_FLUX_ROCM_USE_PREBUILT;
  delete process.env.MANGA_TRANSLATOR_FLUX_ROCM_ALLOW_SOURCE_BUILD;
  delete process.env.MGT_FLUX_ROCM_ALLOW_SOURCE_BUILD;
  delete process.env.MANGA_TRANSLATOR_WINDOWS_KITS_ROOT;
  delete process.env.MGT_WINDOWS_KITS_ROOT;
  delete process.env.MANGA_TRANSLATOR_MSVC_TOOLS_ROOT;
  delete process.env.MGT_MSVC_TOOLS_ROOT;
});

function createTempToolsLayout(): {
  root: string;
  exe: string;
  cuda129: string;
  cuda128: string;
  beellama: string;
} {
  const root = join(
    tmpdir(),
    `mgt-flux-worker-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const tools = join(root, "resources", "tools");
  const runner = join(tools, "mgt-flux-klein");
  const cuda129 = join(tools, "mgt-flux-cuda12.9");
  const cuda128 = join(tools, "mgt-flux-cuda12.8");
  const beellama = join(tools, "beellama-v0.2.0-cuda12.4");
  mkdirSync(runner, { recursive: true });
  mkdirSync(cuda129, { recursive: true });
  mkdirSync(cuda128, { recursive: true });
  mkdirSync(beellama, { recursive: true });
  const exe = join(runner, "mgt-flux-klein.exe");
  writeFileSync(exe, "runner");
  writeFileSync(join(cuda129, "cublas64_12.dll"), "cuda12.9");
  writeFileSync(join(cuda128, "cublas64_12.dll"), "cuda12.8");
  writeFileSync(join(beellama, "cublas64_12.dll"), "cuda12.4");
  return { root, exe, cuda129, cuda128, beellama };
}

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCachedZludaSupportRuntime(runtimeDir: string): string {
  const supportDir = join(runtimeDir, FLUX_ZLUDA_SUPPORT_RUNTIME_DIR);
  mkdirSync(supportDir, { recursive: true });
  writeFileSync(join(supportDir, "curand64_10.dll"), "curand");
  writeFileSync(
    join(supportDir, FLUX_CUDA_RUNTIME_MARKER),
    `${JSON.stringify({ cudaManifest: CUDA_REDIST_MANIFEST_URL })}\n`,
  );
  return supportDir;
}

describe("Flux worker runtime helpers", () => {
  it("uses the managed Flux CUDA 12.9 runtime without mixing older CUDA fallbacks", () => {
    const { exe, cuda129, cuda128, beellama } = createTempToolsLayout();
    const systemCuda129 = join(
      tmpdir(),
      `mgt-system-cuda-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const systemCuda124 = join(
      tmpdir(),
      `mgt-system-cuda-old-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(systemCuda129);
    tempDirs.push(systemCuda124);
    mkdirSync(join(systemCuda129, "bin"), { recursive: true });
    mkdirSync(join(systemCuda124, "bin"), { recursive: true });
    process.env.CUDA_PATH_V12_9 = systemCuda129;
    process.env.CUDA_PATH = systemCuda124;
    const pathParts = buildRuntimePathEnv(exe).split(delimiter);

    expect(pathParts).toContain(cuda129);
    expect(pathParts).not.toContain(cuda128);
    expect(pathParts).not.toContain(beellama);
    expect(pathParts).not.toContain(join(systemCuda124, "bin"));
    expect(pathParts.indexOf(cuda129)).toBeLessThan(
      pathParts.indexOf(join(systemCuda129, "bin")),
    );
  });

  it("only uses broader system CUDA paths when explicitly enabled", () => {
    const { exe } = createTempToolsLayout();
    const systemCuda = join(
      tmpdir(),
      `mgt-system-cuda-allow-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(systemCuda);
    mkdirSync(join(systemCuda, "bin"), { recursive: true });
    process.env.CUDA_PATH = systemCuda;

    expect(buildRuntimePathEnv(exe).split(delimiter)).not.toContain(
      join(systemCuda, "bin"),
    );
    process.env.MGT_FLUX_ALLOW_SYSTEM_CUDA = "1";
    expect(buildRuntimePathEnv(exe).split(delimiter)).toContain(
      join(systemCuda, "bin"),
    );
  });

  it("uses ROCm/HIP paths for Python ROCm workers without adding CUDA runtime folders", () => {
    const { exe, cuda129 } = createTempToolsLayout();
    const rocmRoot = join(
      tmpdir(),
      `mgt-rocm-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const hipRoot = join(
      tmpdir(),
      `mgt-hip-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(rocmRoot, hipRoot);
    mkdirSync(join(rocmRoot, "bin"), { recursive: true });
    mkdirSync(join(hipRoot, "bin"), { recursive: true });
    process.env.ROCM_PATH = rocmRoot;
    process.env.HIP_PATH = hipRoot;

    const pathParts = buildRuntimePathEnv(exe, "python-rocm").split(delimiter);

    expect(pathParts).toContain(join(rocmRoot, "bin"));
    expect(pathParts).toContain(join(hipRoot, "bin"));
    expect(pathParts).not.toContain(cuda129);
  });

  it("removes local build-machine paths from Flux stderr", () => {
    const stderr =
      "thread 'main' panicked at C:\\Users\\sam40\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\cudarc-0.19.7\\src\\lib.rs:200:5: Unable to dynamically load the \"cublas\" shared library\n" +
      "C:\\Users\\sam40\\CARGO~1\\registry\\src\\INDEXC~2.IO-\\AWS-LC~2.0\\aws-lc\\crypto/bio/file.c\n" +
      "C:\\Users\\sam40\\Downloads\\망가번역기\\tools\\mgt-flux-klein-runner\\src\\main.rs:42:1\n";
    const sanitized = sanitizeFluxRuntimeStderr(stderr);

    expect(sanitized).not.toContain("sam40");
    expect(sanitized).not.toContain(".cargo");
    expect(sanitized).toContain("<rust-crate-source>:200:5");
    expect(sanitized).toContain("<flux-runner-source>:42:1");
  });

  it("explains CUDA kernel symbol failures as runner architecture mismatches", () => {
    const error = buildFluxWorkerResponseError(
      'Flux.2 Klein inpainting failed: DriverError(CUDA_ERROR_NOT_FOUND, "named symbol not found")',
      "mgt-flux-klein: worker ready",
      "cuda-native",
    );

    expect(error.message).toContain("Flux CUDA 커널/심볼");
    expect(error.message).toContain("compute capability");
    expect(error.message).toContain("sm86");
  });

  it("passes the managed ZLUDA CUDA support runtime explicitly to the Flux launcher", async () => {
    const runtimeDir = createTempDir("mgt-flux-zluda-");
    const modelDir = createTempDir("mgt-flux-model-");
    const supportDir = writeCachedZludaSupportRuntime(runtimeDir);
    const { exe } = createTempToolsLayout();
    process.env.MGT_FLUX_KLEIN_EXE = exe;

    const launch = await ensureFluxWorkerLaunch({
      runtimeDir,
      modelDir,
      backend: "zluda-native",
    });

    expect(launch.backend).toBe("zluda-native");
    expect(launch.executable).toContain("mgt-flux-klein.exe");
    expect(launch.args).toEqual([
      "--require-zluda",
      "--zluda-runtime-root",
      join(runtimeDir, "koharu-zluda"),
      "--cuda-runtime-dir",
      supportDir,
    ]);
    expect(launch.env).toEqual({
      KOHARU_DATA_ROOT: join(runtimeDir, "koharu-zluda"),
    });
  });

  it("keeps NVIDIA CUDA support DLLs out of the ZLUDA PATH and passes them explicitly", () => {
    const { exe, cuda129 } = createTempToolsLayout();
    const pathParts = buildRuntimePathEnv(exe, "zluda-native").split(delimiter);

    expect(pathParts).not.toContain(cuda129);
  });

  it("refreshes the managed Flux runner when the bundled executable changes", async () => {
    const runtimeDir = createTempDir("mgt-flux-runner-refresh-");
    const sourceDir = createTempDir("mgt-flux-runner-source-");
    const sourceExe = join(sourceDir, "mgt-flux-klein.exe");
    const managedPath = join(
      runtimeDir,
      "mgt-flux-klein",
      "mgt-flux-klein.exe",
    );
    const progress: Array<Record<string, unknown>> = [];
    mkdirSync(join(runtimeDir, "mgt-flux-klein"), { recursive: true });
    writeFileSync(sourceExe, "new-runner");
    writeFileSync(managedPath, "stale-runner");
    process.env.MGT_FLUX_KLEIN_EXE = sourceExe;

    await expect(
      ensureManagedFluxRunner({
        runtimeDir,
        onProgress: (event) => progress.push(event),
      }),
    ).resolves.toBe(managedPath);

    expect(readFileSync(managedPath, "utf8")).toBe("new-runner");
    expect(progress).toContainEqual(
      expect.objectContaining({
        progressText: "Flux 실행 파일 준비 중",
        installLogLine:
          "Flux 실행 파일을 앱 데이터 캐시에 갱신했습니다: mgt-flux-klein.exe",
      }),
    );
  });

  it("prefers the bundled Flux runner matching the NVIDIA compute capability", async () => {
    const runtimeDir = createTempDir("mgt-flux-runner-sm-runtime-");
    const toolsDir = createTempDir("mgt-flux-runner-sm-tools-");
    const genericDir = join(toolsDir, "mgt-flux-klein");
    const sm86Dir = join(toolsDir, "mgt-flux-klein-sm86");
    mkdirSync(genericDir, { recursive: true });
    mkdirSync(sm86Dir, { recursive: true });
    writeFileSync(join(genericDir, "mgt-flux-klein.exe"), "generic-runner");
    writeFileSync(join(sm86Dir, "mgt-flux-klein.exe"), "sm86-runner");
    process.env.MGT_FLUX_KLEIN_TOOLS_DIR = toolsDir;
    const progress: Array<Record<string, unknown>> = [];

    const managedPath = await ensureManagedFluxRunner({
      runtimeDir,
      nvidiaComputeCapability: 8.6,
      onProgress: (event) => progress.push(event),
    });

    expect(managedPath).toBe(
      join(runtimeDir, "mgt-flux-klein-sm86", "mgt-flux-klein.exe"),
    );
    expect(readFileSync(managedPath, "utf8")).toBe("sm86-runner");
    expect(progress).toContainEqual(
      expect.objectContaining({
        progressText: "Flux 실행 파일 준비 중",
        installLogLine:
          "Flux 실행 파일을 앱 데이터 캐시에 갱신했습니다: mgt-flux-klein-sm86/mgt-flux-klein.exe",
      }),
    );
  });

  it("does not use lower or generic Flux runners for a detected NVIDIA GPU", async () => {
    const runtimeDir = createTempDir("mgt-flux-runner-lower-runtime-");
    const toolsDir = createTempDir("mgt-flux-runner-lower-tools-");
    const genericDir = join(toolsDir, "mgt-flux-klein");
    const sm75Dir = join(toolsDir, "mgt-flux-klein-sm75");
    mkdirSync(genericDir, { recursive: true });
    mkdirSync(sm75Dir, { recursive: true });
    writeFileSync(join(genericDir, "mgt-flux-klein.exe"), "generic-runner");
    writeFileSync(join(sm75Dir, "mgt-flux-klein.exe"), "sm75-runner");
    process.env.MGT_FLUX_KLEIN_TOOLS_DIR = toolsDir;
    process.env.MGT_FLUX_DISABLE_REMOTE_RUNNER_DOWNLOAD = "1";

    await expect(
      ensureManagedFluxRunner({
        runtimeDir,
        nvidiaComputeCapability: 8.6,
      }),
    ).rejects.toThrow("mgt-flux-klein-sm86/mgt-flux-klein.exe");
    expect(readFileSync(join(sm75Dir, "mgt-flux-klein.exe"), "utf8")).toBe(
      "sm75-runner",
    );
  });

  it("downloads and verifies the exact NVIDIA Flux runner when it is not bundled", async () => {
    const runtimeDir = createTempDir("mgt-flux-runner-remote-runtime-");
    const toolsDir = createTempDir("mgt-flux-runner-remote-tools-");
    const assetDir = createTempDir("mgt-flux-runner-remote-assets-");
    const fileName = "mgt-flux-klein-sm86-cuda12.9-win-x64.zip";
    const archivePath = join(assetDir, fileName);
    const zip = new AdmZip();
    zip.addFile("mgt-flux-klein.exe", Buffer.from("remote-sm86-runner"));
    zip.writeZip(archivePath);
    const archive = readFileSync(archivePath);
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    const server = createServer((request, response) => {
      const requestPath = new URL(request.url || "/", "http://127.0.0.1")
        .pathname;
      if (requestPath !== `/${fileName}`) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader("Content-Length", String(archive.length));
      if (request.method === "HEAD") {
        response.writeHead(200);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(archive);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("test HTTP server did not bind to a TCP port");
    }
    process.env.MGT_FLUX_KLEIN_TOOLS_DIR = toolsDir;
    process.env.MGT_FLUX_KLEIN_RUNNER_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.MGT_FLUX_KLEIN_RUNNER_SHA256_SM86 = archiveSha256;

    try {
      const managedPath = await ensureManagedFluxRunner({
        runtimeDir,
        nvidiaComputeCapability: 8.6,
      });

      expect(managedPath).toBe(
        join(runtimeDir, "mgt-flux-klein-sm86", "mgt-flux-klein.exe"),
      );
      expect(readFileSync(managedPath, "utf8")).toBe("remote-sm86-runner");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("maps NVIDIA compute capability only to exact packaged Flux runners", () => {
    expect(resolveFluxRunnerDirForComputeCapability(7.5)).toBe(
      "mgt-flux-klein-sm75",
    );
    expect(resolveFluxRunnerDirForComputeCapability(8.0)).toBe(
      "mgt-flux-klein-sm80",
    );
    expect(resolveFluxRunnerDirForComputeCapability(8.6)).toBe(
      "mgt-flux-klein-sm86",
    );
    expect(resolveFluxRunnerDirForComputeCapability(8.7)).toBeNull();
    expect(resolveFluxRunnerDirForComputeCapability(12)).toBe(
      "mgt-flux-klein-sm120",
    );
    expect(resolveFluxRunnerDirForComputeCapability(7)).toBeNull();
  });

  it("keeps Flux scratch run directories under app tmp runtime instead of the model cache", () => {
    const dataRoot = join("C:", "mgt", "data");
    const runtimeDir = join(
      dataRoot,
      "models",
      "inpainting",
      "mgt-flux-klein-runtime",
    );

    expect(resolveDefaultFluxRunRootDir(runtimeDir)).toBe(
      join(dataRoot, "tmp", "runtime", "flux-inpainting"),
    );
    expect(resolveDefaultFluxRunRootDir(runtimeDir)).not.toContain(
      join("models", "inpainting", "flux-klein-4b"),
    );
  });

  it("parses pip wheel download progress for the install overlay", () => {
    expect(
      parsePipDownloadProgressLine(
        "Downloading rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl (490.0 MB)",
      ),
    ).toMatchObject({
      progressBytes: 0,
      progressTotalBytes: 490 * 1024 * 1024,
      progressPercent: 0,
    });

    expect(
      parsePipDownloadProgressLine(
        "Using cached rocm_sdk_core-7.2.1-py3-none-win_amd64.whl (644.8 MB)",
      ),
    ).toMatchObject({
      progressBytes: Math.round(644.8 * 1024 * 1024),
      progressTotalBytes: Math.round(644.8 * 1024 * 1024),
      progressPercent: 1,
    });

    expect(
      parsePipDownloadProgressLine(
        "---------------------------------------- 232.8/232.8 MB 49.5 MB/s  0:00:04",
      ),
    ).toMatchObject({
      progressBytes: Math.round(232.8 * 1024 * 1024),
      progressTotalBytes: Math.round(232.8 * 1024 * 1024),
      progressPercent: 1,
    });
  });

  it("installs the Windows ROCm SDK required by stable-diffusion.cpp HIPBLAS builds", () => {
    const runtimeBatches = resolvePythonRuntimeInstallBatches("python-rocm");
    const buildPackages = resolvePythonBuildPackages("python-rocm");
    const fluxPackages = resolvePythonFluxPackages("python-rocm");

    if (process.platform === "win32") {
      expect(runtimeBatches).toHaveLength(1);
      expect(runtimeBatches[0]).toMatchObject({
        id: "windows-rocm-runtime-7.2.1-sdcpp",
        progressText: "Flux ROCm/HIP 런타임 설치 중",
        installLogLine:
          "AMD Windows ROCm SDK를 stable-diffusion.cpp 빌드용으로 준비합니다.",
      });
      expect(runtimeBatches[0]?.pipArgs).toEqual(
        expect.arrayContaining([
          expect.stringContaining("rocm_sdk_core-7.2.1-py3-none-win_amd64.whl"),
          expect.stringContaining(
            "rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl",
          ),
          expect.stringContaining("rocm-7.2.1.tar.gz"),
        ]),
      );
    } else {
      expect(runtimeBatches).toEqual([]);
    }
    expect(buildPackages).toContain("scikit-build-core>=0.11.0");
    expect(fluxPackages).toEqual(
      expect.arrayContaining([
        "--no-build-isolation",
        "stable-diffusion-cpp-python",
      ]),
    );
    expect(fluxPackages).not.toContain("torch");
    expect(fluxPackages).not.toContain("diffusers>=0.36.0");
  });

  it("uses a prebuilt Flux ROCm runtime on user PCs before any source build path", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["build:flux-rocm-runtime"]).toBe(
      "node scripts/build-flux-rocm-runtime.cjs",
    );
    expect(resolveFluxRocmPrebuiltRuntimeUrl()).toContain(
      "mgt-flux-rocm-win-x64-rocm7.2.1-py3.12.7-sdcpp.zip",
    );
    expect(shouldUsePrebuiltFluxRocmRuntime()).toBe(true);
    expect(shouldAllowFluxRocmSourceBuildFallback()).toBe(false);
    expect(FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST).toBe(
      "mgt-flux-rocm-runtime.json",
    );

    process.env.MGT_FLUX_ROCM_RUNTIME_ARCHIVE_URL =
      "file:///C:/runtime/custom-flux-rocm.zip";
    process.env.MGT_FLUX_ROCM_USE_PREBUILT = "0";
    process.env.MGT_FLUX_ROCM_ALLOW_SOURCE_BUILD = "1";

    expect(resolveFluxRocmPrebuiltRuntimeUrl()).toBe(
      "file:///C:/runtime/custom-flux-rocm.zip",
    );
    expect(shouldUsePrebuiltFluxRocmRuntime()).toBe(false);
    expect(shouldAllowFluxRocmSourceBuildFallback()).toBe(true);
  });

  it("ships a logged reproducible Flux ROCm runtime builder script", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "build-flux-rocm-runtime.cjs"),
      "utf8",
    );

    expect(script).toContain("build.log");
    expect(script).toContain("environment.json");
    expect(script).toContain("mgt-flux-rocm-runtime.json");
    expect(script).toContain("mgt-flux-rocm-win-x64-rocm");
    expect(script).toContain("stable-diffusion-cpp-python");
    expect(script).toContain("--no-build-isolation");
    expect(script).toContain("--force-reinstall");
    expect(script).toContain("rocm_sdk_core");
    expect(script).toContain("rocm_sdk_libraries_custom");
    expect(script).toContain('"rocm_sdk", "init"');
    expect(script).toContain('"rocm_sdk", "path", "--cmake"');
    expect(script).toContain("CMAKE_ARGS");
    expect(script).toContain("-DSD_HIPBLAS=ON");
    expect(script).toContain("-Dhip_DIR:PATH=");
    expect(script).toContain("-DHIP_PLATFORM=amd");
    expect(script).toContain("x86_64-pc-windows-msvc");
    expect(script).toContain("CMAKE_C_STANDARD_LIBRARIES");
    expect(script).toContain("LDFLAGS");
    expect(script).toContain("GPU_TARGETS");
    expect(script).toContain("SHA256");

    for (const target of [
      "gfx1030",
      "gfx1100",
      "gfx1101",
      "gfx1102",
      "gfx1151",
      "gfx1200",
      "gfx1201",
    ]) {
      expect(script).toContain(target);
      expect(DEFAULT_AMD_GPU_TARGETS).toContain(target);
    }
  });

  it("builds Flux Klein CUDA runners with explicit compute-capability variants", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "prepare-flux-klein-runner.cjs"),
      "utf8",
    );

    expect(script).toContain("MGT_FLUX_KLEIN_COMPUTE_CAPS");
    expect(script).toContain("CUDA_COMPUTE_CAP");
    expect(script).toContain("${runnerDirName}-sm");
    expect(script).toContain("index === 0 ? [{ outDir, outExe }] : []");
    expect(script.indexOf("CUDA_PATH_V12_9")).toBeLessThan(
      script.indexOf("MGT_FLUX_ALLOW_CUDA13_BUILD"),
    );
  });

  it("prepares CUDA 12.9 NVIDIA Flux runners before Windows NVIDIA packaging", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const script = readFileSync(
      join(repoRoot, "scripts", "dist-win-thin.cjs"),
      "utf8",
    );

    expect(packageJson.scripts?.["dist:win"]).not.toContain(
      "--with-flux-nvidia",
    );
    expect(packageJson.scripts?.["dist:win:nvidia"]).toContain(
      "--with-flux-nvidia",
    );
    expect(script).toContain("MGT_BUILD_FLUX_NVIDIA_RUNNERS");
    expect(script).toContain("MGT_BUNDLE_FLUX_NVIDIA_RUNNERS");
    expect(script).toContain("MGT_FLUX_KLEIN_COMPUTE_CAPS");
    expect(script).toContain("75,80,86,89,90,120");
    expect(script).toContain("command !== process.execPath");
    expect(script.indexOf("prepare-flux-klein-runner.cjs")).toBeLessThan(
      script.indexOf('run("npm", ["run", "build"])'),
    );
  });

  it("discovers Windows SDK and MSVC import libraries for ROCm source builds", () => {
    if (process.platform !== "win32") {
      return;
    }
    const root = join(
      tmpdir(),
      `mgt-native-build-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(root);
    const sdkRoot = join(root, "Windows Kits", "10");
    const sdkVersion = "10.0.26100.0";
    const sdkUmLib = join(sdkRoot, "Lib", sdkVersion, "um", "x64");
    const sdkUcrtLib = join(sdkRoot, "Lib", sdkVersion, "ucrt", "x64");
    const sdkBin = join(sdkRoot, "bin", sdkVersion, "x64");
    for (const dir of [
      sdkUmLib,
      sdkUcrtLib,
      sdkBin,
      join(sdkRoot, "Include", sdkVersion, "ucrt"),
      join(sdkRoot, "Include", sdkVersion, "shared"),
      join(sdkRoot, "Include", sdkVersion, "um"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const lib of [
      "kernel32.lib",
      "user32.lib",
      "gdi32.lib",
      "shell32.lib",
      "ole32.lib",
      "uuid.lib",
      "advapi32.lib",
    ]) {
      writeFileSync(join(sdkUmLib, lib), "");
    }
    writeFileSync(join(sdkUcrtLib, "ucrt.lib"), "");

    const msvcRoot = join(root, "MSVC", "14.42.34433");
    const msvcLib = join(msvcRoot, "lib", "x64");
    const msvcInclude = join(msvcRoot, "include");
    const msvcBin = join(msvcRoot, "bin", "Hostx64", "x64");
    for (const dir of [msvcLib, msvcInclude, msvcBin]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const lib of [
      "oldnames.lib",
      "msvcrt.lib",
      "msvcrtd.lib",
      "vcruntime.lib",
    ]) {
      writeFileSync(join(msvcLib, lib), "");
    }

    process.env.MANGA_TRANSLATOR_WINDOWS_KITS_ROOT = sdkRoot;
    process.env.MANGA_TRANSLATOR_MSVC_TOOLS_ROOT = msvcRoot;
    const buildEnv = resolveWindowsNativeBuildEnv();

    expect(buildEnv).toBeTruthy();
    expect(buildEnv?.sdkVersion).toBe(sdkVersion);
    expect(buildEnv?.libPaths).toContain(sdkUmLib);
    expect(buildEnv?.libPaths).toContain(sdkUcrtLib);
    expect(buildEnv?.libPaths).toContain(msvcLib);
    expect(buildEnv?.includePaths).toContain(msvcInclude);
    expect(buildEnv?.pathEntries).toContain(sdkBin);
    expect(buildEnv?.pathEntries).toContain(msvcBin);
  });

  it("uses stable-diffusion.cpp GGUF assets for ROCm workers instead of Diffusers", () => {
    expect(resolveFluxPythonWorkerFile("python-rocm")).toBe(FLUX_SDCPP_WORKER);
    expect(resolvePythonFluxPackages("python-rocm")).toEqual(
      expect.arrayContaining([
        "--no-build-isolation",
        "stable-diffusion-cpp-python",
      ]),
    );
    expect(resolvePythonFluxPackages("python-rocm")).not.toEqual(
      expect.arrayContaining(["diffusers>=0.36.0", "transformers>=4.56.0"]),
    );
  });

  it("invalidates cached Flux Python workers when the bundled worker changes", async () => {
    const runtimeDir = createTempDir("mgt-flux-worker-refresh-");
    const workerFile = resolveFluxPythonWorkerFile("python-rocm");
    const workerPath = join(runtimeDir, workerFile);
    writeFileSync(workerPath, "stale-worker");

    await expect(ensureFluxPythonWorker(runtimeDir, workerFile)).resolves.toBe(
      workerPath,
    );

    expect(readFileSync(workerPath, "utf8")).not.toBe("stale-worker");
    expect(readFileSync(workerPath, "utf8")).toContain("stable_diffusion_cpp");
  });

  it("keeps Windows ROCm Python runtime paths short enough for long ROCm wheel entries", () => {
    if (process.platform !== "win32") {
      return;
    }
    const previousLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\taepotaepo\\AppData\\Local";
    try {
      const baseRuntimeDir =
        "C:\\Users\\taepotaepo\\AppData\\Local\\Programs\\manga-gemma-translator\\data\\models\\inpainting\\mgt-flux-klein-runtime";
      const layout = resolveFluxPythonRuntimeLayout(
        baseRuntimeDir,
        "python-rocm",
      );
      const longRocmEntry = join(
        layout.packageDir,
        "_rocm_sdk_libraries_custom",
        "bin",
        "hipblaslt",
        "library",
        "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co",
      );
      const longPipTempEntry = join(
        layout.runtimeDir,
        "t",
        "pip-target-wnkr20fe",
        "lib",
        "python",
        "_rocm_sdk_libraries_custom",
        "bin",
        "hipblaslt",
        "library",
        "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co",
      );

      expect(layout.packageDir).toContain(`${join("MGTFlux", "r721")}\\`);
      expect(layout.packageDir).not.toContain(`${join("data", "fx")}\\`);
      expect(layout.packageDir).not.toContain("mgt-flux-klein-runtime");
      expect(layout.packageDir).not.toContain("python-packages");
      expect(longRocmEntry.length).toBeLessThan(252);
      expect(longPipTempEntry.length).toBeLessThan(252);
      expect(layout.tempDir.length).toBeLessThan(layout.packageDir.length + 2);
    } finally {
      if (previousLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = previousLocalAppData;
      }
    }
  });

  it("keeps Windows ROCm runtime under data root when the installed data path is short enough", () => {
    if (process.platform !== "win32") {
      return;
    }
    const previousLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA =
      "C:\\Users\\very-long-user-name-for-testing\\AppData\\Local";
    try {
      const baseRuntimeDir =
        "D:\\mgt\\data\\models\\inpainting\\mgt-flux-klein-runtime";
      const layout = resolveFluxPythonRuntimeLayout(
        baseRuntimeDir,
        "python-rocm",
      );
      const longPipTempEntry = join(
        layout.runtimeDir,
        "t",
        "pip-target-wnkr20fe",
        "lib",
        "python",
        "_rocm_sdk_libraries_custom",
        "bin",
        "hipblaslt",
        "library",
        "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co",
      );

      expect(layout.packageDir).toBe(
        `${join("D:\\mgt\\data", "fx", "r721", "p")}`,
      );
      expect(longPipTempEntry.length).toBeLessThan(252);
    } finally {
      if (previousLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = previousLocalAppData;
      }
    }
  });

  it("allows advanced users to override the Windows ROCm runtime directory", () => {
    if (process.platform !== "win32") {
      return;
    }
    process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_DIR = "R:\\mgtflux\\r721";

    const layout = resolveFluxPythonRuntimeLayout(
      "C:\\Users\\taepotaepo\\AppData\\Local\\Programs\\manga-gemma-translator\\data\\models\\inpainting\\mgt-flux-klein-runtime",
      "python-rocm",
    );

    expect(layout.runtimeDir).toBe("R:\\mgtflux\\r721");
    expect(layout.packageDir).toBe(`${join("R:\\mgtflux\\r721", "p")}`);
  });
});
