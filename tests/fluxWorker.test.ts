import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ensureFluxWorkerLaunch } from "../src/main/inpainting/fluxAssets/workerLaunch";
import { parsePipDownloadProgressLine } from "../src/main/inpainting/fluxAssets/progress";
import { resolveFluxPythonRuntimeLayout } from "../src/main/inpainting/fluxAssets/pythonRuntimeLayout";
import { resolveWindowsNativeBuildEnv } from "../src/main/inpainting/fluxAssets/windowsBuildEnv";
import {
  CUDNN_REDIST_MANIFEST_URL,
  CUDA_REDIST_MANIFEST_URL,
  DEFAULT_AMD_GPU_TARGETS,
  FLUX_CUDA_DLLS,
  FLUX_CUDA_RUNTIME_DIR,
  FLUX_CUDA_RUNTIME_MARKER,
  FLUX_CUDNN_DLLS,
  FLUX_ROCM_PREBUILT_EXTRACTION_LIMITS,
  FLUX_ROCM_PREBUILT_RUNTIME_BYTES,
  FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST,
  FLUX_ROCM_PREBUILT_RUNTIME_PARTS,
  FLUX_ROCM_PREBUILT_RUNTIME_SHA256,
  FLUX_SDCPP_WORKER,
  FLUX_ZLUDA_SUPPORT_RUNTIME_DIR,
} from "../src/main/inpainting/fluxAssets/constants";
import {
  ensureManagedFluxRunner,
  resolveFluxRunnerDirForComputeCapability,
} from "../src/main/inpainting/fluxAssets/runner";
import {
  resolveFluxPythonWorkerFile,
  ensureFluxPythonWorker,
} from "../src/main/inpainting/fluxAssets/pythonRuntimeLayout";
import {
  ensureEmbeddedPythonPackagePath,
  sanitizeStandaloneEmbeddedPythonPathFile,
} from "../src/main/inpainting/fluxAssets/pythonPathFile";
import {
  resolveFluxRocmPrebuiltRuntimeUrl,
  resolveFluxRocmPrebuiltRuntimeSha256,
  resolvePythonBuildPackages,
  resolvePythonFluxPackages,
  resolvePythonRuntimeInstallBatches,
  shouldUsePrebuiltFluxRocmRuntime,
} from "../src/main/inpainting/fluxAssets/manifests";
import { resolveDefaultFluxRunRootDir } from "../src/main/inpainting/fluxEngine";
import {
  buildFluxWorkerResponseError,
  sanitizeFluxRuntimeStderr,
} from "../src/main/inpainting/fluxWorkerErrors";
import { buildRuntimePathEnv } from "../src/main/inpainting/fluxWorkerEnv";
import { assembleFluxRocmRuntimeArchiveParts } from "../src/main/inpainting/fluxAssets/rocmPrebuiltArchive";

const tempDirs: string[] = [];
const repoRoot = join(__dirname, "..");
const require = createRequire(import.meta.url);
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
  delete process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_ARCHIVE_SHA256;
  delete process.env.MGT_FLUX_ROCM_RUNTIME_ARCHIVE_SHA256;
  delete process.env.MANGA_TRANSLATOR_FLUX_ROCM_USE_PREBUILT;
  delete process.env.MGT_FLUX_ROCM_USE_PREBUILT;
  delete process.env.MANGA_TRANSLATOR_WINDOWS_KITS_ROOT;
  delete process.env.MGT_WINDOWS_KITS_ROOT;
  delete process.env.MANGA_TRANSLATOR_MSVC_TOOLS_ROOT;
  delete process.env.MGT_MSVC_TOOLS_ROOT;
  delete process.env.MANGA_TRANSLATOR_LOG_PATH;
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

function writeCachedFluxCudaRuntime(runtimeDir: string): string {
  const cudaDir = join(runtimeDir, FLUX_CUDA_RUNTIME_DIR);
  mkdirSync(cudaDir, { recursive: true });
  for (const fileName of [...FLUX_CUDA_DLLS, ...FLUX_CUDNN_DLLS]) {
    writeFileSync(join(cudaDir, fileName), fileName);
  }
  writeFileSync(
    join(cudaDir, FLUX_CUDA_RUNTIME_MARKER),
    `${JSON.stringify({ cudnnManifest: CUDNN_REDIST_MANIFEST_URL })}\n`,
  );
  return cudaDir;
}

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("Flux worker runtime helpers", () => {
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
    process.env.MANGA_TRANSLATOR_LOG_PATH = join(runtimeDir, "app.log");

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

  it("passes the managed CUDA runtime explicitly to the native Flux launcher", async () => {
    const runtimeDir = createTempDir("mgt-flux-cuda-");
    const modelDir = createTempDir("mgt-flux-model-");
    const cudaDir = writeCachedFluxCudaRuntime(runtimeDir);
    const { exe } = createTempToolsLayout();
    process.env.MGT_FLUX_KLEIN_EXE = exe;
    process.env.MANGA_TRANSLATOR_LOG_PATH = join(runtimeDir, "app.log");

    const launch = await ensureFluxWorkerLaunch({
      runtimeDir,
      modelDir,
      backend: "cuda-native",
    });

    expect(launch.backend).toBe("cuda-native");
    expect(launch.args).toEqual(["--cuda-runtime-dir", cudaDir]);
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
    expect(FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST).toBe(
      "mgt-flux-rocm-runtime.json",
    );
    expect(
      resolveFluxRocmPrebuiltRuntimeSha256(resolveFluxRocmPrebuiltRuntimeUrl()),
    ).toBe(FLUX_ROCM_PREBUILT_RUNTIME_SHA256);
    expect(
      FLUX_ROCM_PREBUILT_RUNTIME_PARTS.reduce(
        (total, part) => total + part.bytes,
        0,
      ),
    ).toBe(FLUX_ROCM_PREBUILT_RUNTIME_BYTES);
    expect(
      FLUX_ROCM_PREBUILT_RUNTIME_PARTS.every(
        (part) => part.bytes < 2 * 1024 * 1024 * 1024,
      ),
    ).toBe(true);
    expect(FLUX_ROCM_PREBUILT_EXTRACTION_LIMITS).toMatchObject({
      maximumEntries: 20_336,
      maximumExpandedBytes: 10_679_266_773,
    });

    process.env.MGT_FLUX_ROCM_RUNTIME_ARCHIVE_URL =
      "file:///C:/runtime/custom-flux-rocm.zip";
    expect(() =>
      resolveFluxRocmPrebuiltRuntimeSha256(resolveFluxRocmPrebuiltRuntimeUrl()),
    ).toThrow("requires an explicit SHA-256");

    process.env.MGT_FLUX_ROCM_RUNTIME_ARCHIVE_SHA256 = "a".repeat(64);
    expect(
      resolveFluxRocmPrebuiltRuntimeSha256(resolveFluxRocmPrebuiltRuntimeUrl()),
    ).toBe("a".repeat(64));
    process.env.MGT_FLUX_ROCM_USE_PREBUILT = "0";

    expect(resolveFluxRocmPrebuiltRuntimeUrl()).toBe(
      "file:///C:/runtime/custom-flux-rocm.zip",
    );
    expect(shouldUsePrebuiltFluxRocmRuntime()).toBe(false);
  });

  it("reassembles pinned Flux ROCm release parts without replacing a known-good archive on failure", async () => {
    const root = createTempDir("mgt-flux-rocm-parts-");
    const partOne = join(root, "runtime.zip.part-001");
    const partTwo = join(root, "runtime.zip.part-002");
    const outputPath = join(root, "runtime.zip");
    const expected = Buffer.from("legacy-rocm-runtime-archive");
    writeFileSync(partOne, expected.subarray(0, 11));
    writeFileSync(partTwo, expected.subarray(11));
    writeFileSync(outputPath, "previous-known-good");

    await assembleFluxRocmRuntimeArchiveParts({
      partPaths: [partOne, partTwo],
      outputPath,
      expectedBytes: expected.length,
      expectedSha256: createHash("sha256").update(expected).digest("hex"),
    });
    expect(readFileSync(outputPath)).toEqual(expected);

    writeFileSync(outputPath, "previous-known-good");
    await expect(
      assembleFluxRocmRuntimeArchiveParts({
        partPaths: [partOne, partTwo],
        outputPath,
        expectedBytes: expected.length,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("release parts SHA-256 mismatch");
    expect(readFileSync(outputPath, "utf8")).toBe("previous-known-good");
  });

  it("removes the legacy ROCm build path before injecting the installed package directory", () => {
    const root = createTempDir("mgt-flux-rocm-python-path-");
    const pythonDir = join(root, "bootstrap-python", "python-3.12.7");
    const packageDir = join(root, "p");
    mkdirSync(pythonDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(pythonDir, "python312.zip"), "stdlib");
    writeFileSync(
      join(pythonDir, "python312._pth"),
      "python312.zip\n.\nC:\\old-build\\runtime\\p\nimport site\n",
    );

    sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);
    ensureEmbeddedPythonPackagePath(join(pythonDir, "python.exe"), packageDir);

    const pth = readFileSync(join(pythonDir, "python312._pth"), "utf8");
    expect(pth).not.toContain("old-build");
    expect(pth).toContain(packageDir);
    expect(pth).toContain("python312.zip");
    expect(pth.trimEnd().endsWith("import site")).toBe(true);
  });

  it("builds a reproducible Flux ROCm runtime context from explicit inputs", () => {
    const config = require("../scripts/flux-rocm-build/config.cjs") as {
      manifestFile: string;
      outputFileName: string;
      rocmPackageUrls: string[];
      buildPackages: string[];
      fluxPackages: string[];
      defaultAmdGpuTargets: string[];
      releasePartBytes: number;
      windowsMsvcCompilerTarget: string;
    };
    const { createBuildContext } =
      require("../scripts/flux-rocm-build/runner.cjs") as {
        createBuildContext(argv: string[]): {
          outputPath: string;
          workDir: string;
          runtimeDir: string;
          logPath: string;
          envPath: string;
          force: boolean;
          logger: { close(): void };
        };
      };
    const workDir = join(tmpdir(), `mgt-rocm-context-${Date.now()}`);
    const outputPath = join(workDir, "runtime.zip");
    const context = createBuildContext([
      "--out",
      outputPath,
      "--work-dir",
      workDir,
      "--force",
    ]);
    context.logger.close();

    expect(context).toMatchObject({
      outputPath,
      workDir,
      runtimeDir: join(workDir, "runtime"),
      logPath: join(workDir, "logs", "build.log"),
      envPath: join(workDir, "logs", "environment.json"),
      force: true,
    });
    expect(config.manifestFile).toBe("mgt-flux-rocm-runtime.json");
    expect(config.outputFileName).toContain("mgt-flux-rocm-win-x64-rocm");
    expect(config.rocmPackageUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("rocm_sdk_core"),
        expect.stringContaining("rocm_sdk_libraries_custom"),
      ]),
    );
    expect(config.buildPackages).toContain("scikit-build-core>=0.11.0");
    expect(config.fluxPackages).toEqual(
      expect.arrayContaining([
        "--no-build-isolation",
        "--force-reinstall",
        "stable-diffusion-cpp-python",
      ]),
    );
    expect(config.windowsMsvcCompilerTarget).toBe("x86_64-pc-windows-msvc");
    expect(config.defaultAmdGpuTargets).toEqual(DEFAULT_AMD_GPU_TARGETS);
    expect(config.releasePartBytes).toBe(1_900_000_000);
    expect(config.releasePartBytes).toBeLessThan(2 * 1024 * 1024 * 1024);
  });

  it("splits a Flux ROCm runtime into GitHub-sized release assets", async () => {
    const root = createTempDir("mgt-rocm-release-parts-");
    const archivePath = join(root, "runtime.zip");
    const archive = Buffer.from("0123456789abcdefghijklmnop");
    writeFileSync(archivePath, archive);
    const lines: string[] = [];
    const { splitRuntimeArchiveForRelease } =
      require("../scripts/flux-rocm-build/runtime-package.cjs") as {
        splitRuntimeArchiveForRelease: (options: {
          archivePath: string;
          partBytes: number;
          logger: { line: (line: string) => void };
        }) => Promise<Array<{ file: string; bytes: number; sha256: string }>>;
      };

    const parts = await splitRuntimeArchiveForRelease({
      archivePath,
      partBytes: 10,
      logger: { line: (line) => lines.push(line) },
    });

    expect(parts.map((part) => part.bytes)).toEqual([10, 10, 6]);
    expect(
      Buffer.concat(parts.map((part) => readFileSync(join(root, part.file)))),
    ).toEqual(archive);
    expect(parts.map((part) => part.sha256)).toEqual(
      parts.map((part) =>
        createHash("sha256")
          .update(readFileSync(join(root, part.file)))
          .digest("hex"),
      ),
    );
    expect(lines).toHaveLength(3);
  });

  it("builds Flux Klein CUDA runners with explicit compute-capability variants", () => {
    const {
      createCudaRootCandidates,
      createFluxCargoInvocation,
      createFluxKleinBuildPlan,
    } = require("../scripts/flux-klein-build-plan.cjs") as {
      createCudaRootCandidates(
        env: NodeJS.ProcessEnv,
      ): Array<string | undefined>;
      createFluxCargoInvocation(options: {
        manifestPath: string;
        buildTarget: {
          computeCap: string | null;
          cargoTargetDir: string;
          outDir: string;
          outExe: string;
          aliases: Array<{ outDir: string; outExe: string }>;
        };
        cudaRoot: string | null;
        msvcBin: string | null;
        rustFlags: string;
        basePath: string;
        pathDelimiter: string;
      }): {
        command: string;
        args: string[];
        env: NodeJS.ProcessEnv;
      };
      createFluxKleinBuildPlan(options: {
        root: string;
        cargoTargetDir: string;
        computeCaps?: unknown;
        singleComputeCap?: unknown;
      }): Array<{
        computeCap: string | null;
        cargoTargetDir: string;
        outDir: string;
        outExe: string;
        aliases: Array<{ outDir: string; outExe: string }>;
      }>;
    };
    const targetDir = join(repoRoot, ".tmp", "flux-target");
    const plan = createFluxKleinBuildPlan({
      root: repoRoot,
      cargoTargetDir: targetDir,
      computeCaps: "sm_75, 8.0;86,8.0",
    });

    expect(plan.map((entry) => entry.computeCap)).toEqual(["75", "80", "86"]);
    expect(plan.map((entry) => entry.outDir)).toEqual([
      join(repoRoot, "tools", "mgt-flux-klein-sm75"),
      join(repoRoot, "tools", "mgt-flux-klein-sm80"),
      join(repoRoot, "tools", "mgt-flux-klein-sm86"),
    ]);
    expect(plan[0]?.aliases).toEqual([
      {
        outDir: join(repoRoot, "tools", "mgt-flux-klein"),
        outExe: join(repoRoot, "tools", "mgt-flux-klein", "mgt-flux-klein.exe"),
      },
    ]);
    expect(plan[1]?.aliases).toEqual([]);

    const sm80Target = plan[1];
    if (!sm80Target) {
      throw new Error("Expected an sm80 Flux build target");
    }
    const invocation = createFluxCargoInvocation({
      manifestPath: join(
        repoRoot,
        "tools",
        "mgt-flux-klein-runner",
        "Cargo.toml",
      ),
      buildTarget: sm80Target,
      cudaRoot: "C:\\CUDA\\v12.9",
      msvcBin: "C:\\MSVC\\bin",
      rustFlags: "--remap-path-prefix=C:\\repo=<mgt-source>",
      basePath: "C:\\Windows\\System32",
      pathDelimiter: ";",
    });
    expect(invocation).toMatchObject({
      command: "cargo",
      args: [
        "build",
        "--release",
        "--manifest-path",
        join(repoRoot, "tools", "mgt-flux-klein-runner", "Cargo.toml"),
      ],
      env: {
        CARGO_TARGET_DIR: join(targetDir, "sm80"),
        CUDA_COMPUTE_CAP: "80",
        CUDA_PATH: "C:\\CUDA\\v12.9",
        CUDACXX: join("C:\\CUDA\\v12.9", "bin", "nvcc.exe"),
      },
    });
    expect(invocation.env.PATH?.split(";").slice(0, 2)).toEqual([
      join("C:\\CUDA\\v12.9", "bin"),
      "C:\\MSVC\\bin",
    ]);

    const cudaCandidates = createCudaRootCandidates({
      CUDA_PATH_V12_9: "C:\\CUDA\\v12.9",
      CUDA_PATH_V13_1: "C:\\CUDA\\v13.1",
      MGT_FLUX_ALLOW_CUDA13_BUILD: "1",
    });
    expect(cudaCandidates.indexOf("C:\\CUDA\\v12.9")).toBeLessThan(
      cudaCandidates.indexOf("C:\\CUDA\\v13.1"),
    );
  });

  it("locks both runners to the shared Rust CUDA runtime probe policy", () => {
    const policyManifest = readFileSync(
      join(repoRoot, "tools", "runner-runtime-policy", "Cargo.toml"),
      "utf8",
    );
    expect(policyManifest).toMatch(
      /name\s*=\s*"runner-runtime-policy"[\s\S]*path\s*=\s*"src\/lib\.rs"/,
    );

    for (const runner of [
      "mgt-flux-klein-runner",
      "mgt-koharu-inpaint-runner",
    ]) {
      const manifest = readFileSync(
        join(repoRoot, "tools", runner, "Cargo.toml"),
        "utf8",
      );
      const lock = readFileSync(
        join(repoRoot, "tools", runner, "Cargo.lock"),
        "utf8",
      );
      expect(manifest).toMatch(
        /runner-runtime-policy\s*=\s*\{\s*path\s*=\s*"\.\.\/runner-runtime-policy"\s*\}/,
      );
      expect(lock).toMatch(
        /name = "runner-runtime-policy"\nversion = "0\.1\.0"/,
      );
    }
  });

  it("prepares CUDA 12.9 NVIDIA Flux runners before Windows NVIDIA packaging", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const {
      createWindowsThinDistributionPlan,
      shouldBuildFluxNvidiaRunners,
      shouldUseDistributionShell,
    } = require("../scripts/windows-thin-dist-plan.cjs") as {
      createWindowsThinDistributionPlan(options: {
        nodeCommand: string;
        withFluxNvidia: boolean;
        env: NodeJS.ProcessEnv;
      }): Array<{
        command: string;
        args: string[];
        env: NodeJS.ProcessEnv;
      }>;
      shouldBuildFluxNvidiaRunners(
        argv: string[],
        env: NodeJS.ProcessEnv,
      ): boolean;
      shouldUseDistributionShell(
        command: string,
        nodeCommand: string,
        platform: NodeJS.Platform,
      ): boolean;
    };

    expect(packageJson.scripts?.["dist:win"]).not.toContain(
      "--with-flux-nvidia",
    );
    expect(packageJson.scripts?.["dist:win:nvidia"]).toContain(
      "--with-flux-nvidia",
    );
    expect(
      shouldBuildFluxNvidiaRunners(["node", "dist", "--with-flux-nvidia"], {}),
    ).toBe(true);
    expect(
      shouldBuildFluxNvidiaRunners([], {
        MGT_BUILD_FLUX_NVIDIA_RUNNERS: "1",
      }),
    ).toBe(true);

    const plan = createWindowsThinDistributionPlan({
      nodeCommand: "C:\\node\\node.exe",
      withFluxNvidia: true,
      env: {},
    });
    expect(plan).toEqual([
      {
        command: "C:\\node\\node.exe",
        args: ["scripts/prepare-flux-klein-runner.cjs"],
        env: {
          MGT_FLUX_KLEIN_COMPUTE_CAPS: "75,80,86,89,90,120",
          MGT_FORCE_REBUILD_FLUX_RUNNER: "1",
        },
      },
      { command: "npm", args: ["run", "build"], env: {} },
      {
        command: "C:\\node\\node.exe",
        args: ["scripts/build-windows-installer.cjs"],
        env: { MGT_BUNDLE_FLUX_NVIDIA_RUNNERS: "1" },
      },
      {
        command: "C:\\node\\node.exe",
        args: ["scripts/verify-packaged-runtime.cjs"],
        env: {},
      },
    ]);
    expect(
      shouldUseDistributionShell(
        "C:\\node\\node.exe",
        "C:\\node\\node.exe",
        "win32",
      ),
    ).toBe(false);
    expect(
      shouldUseDistributionShell("npm", "C:\\node\\node.exe", "win32"),
    ).toBe(true);
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
