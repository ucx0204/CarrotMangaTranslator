import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parsePipDownloadProgressLine, resolveFluxPythonRuntimeLayout, resolveWindowsNativeBuildEnv } from "../src/main/inpainting/fluxAssets";
import { buildRuntimePathEnv, sanitizeFluxRuntimeStderr } from "../src/main/inpainting/fluxWorker";

const tempDirs: string[] = [];
const repoRoot = join(__dirname, "..");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CUDA_PATH_V12_9;
  delete process.env.MGT_FLUX_ALLOW_SYSTEM_CUDA;
  delete process.env.CUDA_PATH;
  delete process.env.ROCM_PATH;
  delete process.env.HIP_PATH;
  delete process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_DIR;
  delete process.env.MGT_FLUX_ROCM_RUNTIME_DIR;
  delete process.env.MANGA_TRANSLATOR_WINDOWS_KITS_ROOT;
  delete process.env.MGT_WINDOWS_KITS_ROOT;
  delete process.env.MANGA_TRANSLATOR_MSVC_TOOLS_ROOT;
  delete process.env.MGT_MSVC_TOOLS_ROOT;
});

function createTempToolsLayout(): { root: string; exe: string; cuda129: string; cuda128: string; beellama: string } {
  const root = join(tmpdir(), `mgt-flux-worker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

describe("Flux worker runtime helpers", () => {
  it("uses the managed Flux CUDA 12.9 runtime without mixing older CUDA fallbacks", () => {
    const { exe, cuda129, cuda128, beellama } = createTempToolsLayout();
    const systemCuda129 = join(tmpdir(), `mgt-system-cuda-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const systemCuda124 = join(tmpdir(), `mgt-system-cuda-old-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
    expect(pathParts.indexOf(cuda129)).toBeLessThan(pathParts.indexOf(join(systemCuda129, "bin")));
  });

  it("only uses broader system CUDA paths when explicitly enabled", () => {
    const { exe } = createTempToolsLayout();
    const systemCuda = join(tmpdir(), `mgt-system-cuda-allow-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(systemCuda);
    mkdirSync(join(systemCuda, "bin"), { recursive: true });
    process.env.CUDA_PATH = systemCuda;

    expect(buildRuntimePathEnv(exe).split(delimiter)).not.toContain(join(systemCuda, "bin"));
    process.env.MGT_FLUX_ALLOW_SYSTEM_CUDA = "1";
    expect(buildRuntimePathEnv(exe).split(delimiter)).toContain(join(systemCuda, "bin"));
  });

  it("uses ROCm/HIP paths for Python ROCm workers without adding CUDA runtime folders", () => {
    const { exe, cuda129 } = createTempToolsLayout();
    const rocmRoot = join(tmpdir(), `mgt-rocm-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const hipRoot = join(tmpdir(), `mgt-hip-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
      'thread \'main\' panicked at C:\\Users\\sam40\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\cudarc-0.19.7\\src\\lib.rs:200:5: Unable to dynamically load the "cublas" shared library\n' +
      "C:\\Users\\sam40\\CARGO~1\\registry\\src\\INDEXC~2.IO-\\AWS-LC~2.0\\aws-lc\\crypto/bio/file.c\n" +
      "C:\\Users\\sam40\\Downloads\\망가번역기\\tools\\mgt-flux-klein-runner\\src\\main.rs:42:1\n";
    const sanitized = sanitizeFluxRuntimeStderr(stderr);

    expect(sanitized).not.toContain("sam40");
    expect(sanitized).not.toContain(".cargo");
    expect(sanitized).toContain("<rust-crate-source>:200:5");
    expect(sanitized).toContain("<flux-runner-source>:42:1");
  });

  it("keeps Flux scratch run directories under app tmp runtime instead of the model cache", () => {
    const poolSource = readFileSync(join(repoRoot, "src", "main", "inpainting", "fluxEnginePool.ts"), "utf8");
    const fluxEngineSource = readFileSync(join(repoRoot, "src", "main", "inpainting", "fluxEngine.ts"), "utf8");

    expect(poolSource).toContain('join(options.appPaths.dataRoot, "tmp", "runtime", "flux-inpainting")');
    expect(fluxEngineSource).toContain("join(options.runRootDir");
    expect(fluxEngineSource).not.toContain('dirname(options.modelPath), "runs"');
  });

  it("parses pip wheel download progress for the install overlay", () => {
    expect(parsePipDownloadProgressLine("Downloading rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl (490.0 MB)")).toMatchObject({
      progressBytes: 0,
      progressTotalBytes: 490 * 1024 * 1024,
      progressPercent: 0
    });

    expect(parsePipDownloadProgressLine("Using cached rocm_sdk_core-7.2.1-py3-none-win_amd64.whl (644.8 MB)")).toMatchObject({
      progressBytes: Math.round(644.8 * 1024 * 1024),
      progressTotalBytes: Math.round(644.8 * 1024 * 1024),
      progressPercent: 1
    });

    expect(parsePipDownloadProgressLine("---------------------------------------- 232.8/232.8 MB 49.5 MB/s  0:00:04")).toMatchObject({
      progressBytes: Math.round(232.8 * 1024 * 1024),
      progressTotalBytes: Math.round(232.8 * 1024 * 1024),
      progressPercent: 1
    });
  });

  it("installs the Windows ROCm SDK required by stable-diffusion.cpp HIPBLAS builds", () => {
    const fluxAssetsSource = readFileSync(join(repoRoot, "src", "main", "inpainting", "fluxAssets.ts"), "utf8");

    expect(fluxAssetsSource).toContain("rocm_sdk_core-${version}-py3-none-win_amd64.whl");
    expect(fluxAssetsSource).toContain("rocm-${version}.tar.gz");
    expect(fluxAssetsSource).toContain("id: `windows-rocm-runtime-${FLUX_ROCM_WINDOWS_VERSION}-sdcpp`");
    expect(fluxAssetsSource).toContain("pipArgs: rocmPackageUrls");
    expect(fluxAssetsSource).toContain("stable-diffusion.cpp 빌드용");
    expect(fluxAssetsSource).toContain("scikit-build-core>=0.11.0");
    expect(fluxAssetsSource).toContain("--no-build-isolation");
    expect(fluxAssetsSource).toContain('join(packageDir, "_rocm_sdk_core", "lib", "llvm", "bin")');
    expect(fluxAssetsSource).toContain("-DCMAKE_C_COMPILER:FILEPATH=");
    expect(fluxAssetsSource).toContain("-DCMAKE_RC_COMPILER:FILEPATH=");
    expect(fluxAssetsSource).toContain("env.RC = env.RC || rocmPaths.llvmRc");
    expect(fluxAssetsSource).toContain("env.CC = env.CC || rocmPaths.clang");
    expect(fluxAssetsSource).toContain("env.CXX = env.CXX || rocmPaths.clangxx");
    expect(fluxAssetsSource).toContain("resolveWindowsNativeBuildEnv()");
    expect(fluxAssetsSource).toContain("env.LIB = mergePathList(env.LIB, nativeBuildEnv.libPaths)");
    expect(fluxAssetsSource).toContain("env.INCLUDE = mergePathList(env.INCLUDE, nativeBuildEnv.includePaths)");
    expect(fluxAssetsSource).toContain("-DCMAKE_TRY_COMPILE_CONFIGURATION=Release");
    expect(fluxAssetsSource).toContain("kernel32.lib");
    expect(fluxAssetsSource).toContain("oldnames.lib");
    expect(fluxAssetsSource).toContain("vcruntime.lib");
    expect(fluxAssetsSource).toContain("-DCMAKE_C_COMPILER_TARGET=");
    expect(fluxAssetsSource).toContain("-DCMAKE_C_STANDARD_LIBRARIES:STRING=");
    expect(fluxAssetsSource).toContain("env.LDFLAGS = mergeWords(env.LDFLAGS");
    expect(fluxAssetsSource).toContain('clang: join(llvmBin, "clang.exe")');
    expect(fluxAssetsSource).toContain('clangxx: join(llvmBin, "clang++.exe")');
    expect(fluxAssetsSource).toContain('llvmRc: join(llvmBin, "llvm-rc.exe")');
    expect(fluxAssetsSource).toContain('llvmMt: join(llvmBin, "llvm-mt.exe")');
    expect(fluxAssetsSource).toContain("stable-diffusion.cpp Python 바인딩 빌드 도구를 먼저 설치합니다.");
    expect(fluxAssetsSource).not.toContain("id: `windows-rocm-pytorch-${FLUX_ROCM_WINDOWS_TORCH_VERSION}`");
    expect(fluxAssetsSource).not.toContain("torchWheelUrls");
    expect(fluxAssetsSource).not.toContain("Flux ROCm/PyTorch 설치 중");
  });

  it("uses a prebuilt Flux ROCm runtime on user PCs before any source build path", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const fluxAssetsSource = readFileSync(join(repoRoot, "src", "main", "inpainting", "fluxAssets.ts"), "utf8");

    expect(packageJson.scripts?.["build:flux-rocm-runtime"]).toBe("node scripts/build-flux-rocm-runtime.cjs");
    expect(fluxAssetsSource).toContain("FLUX_ROCM_PREBUILT_RUNTIME_URL");
    expect(fluxAssetsSource).toContain("ensurePrebuiltFluxRocmPythonRuntime");
    expect(fluxAssetsSource).toContain("MGT_FLUX_ROCM_RUNTIME_ARCHIVE_URL");
    expect(fluxAssetsSource).toContain("MGT_FLUX_ROCM_USE_PREBUILT");
    expect(fluxAssetsSource).toContain("MGT_FLUX_ROCM_ALLOW_SOURCE_BUILD");
    expect(fluxAssetsSource).toContain("사용자 PC에서 C++/ROCm 소스 빌드는 비활성화");
    expect(fluxAssetsSource).toContain("validatePrebuiltFluxRocmRuntime");
    expect(fluxAssetsSource).toContain("mgt-flux-rocm-runtime.json");
    expect(fluxAssetsSource).toContain("requireNativeBuildEnv: true");
  });

  it("ships a logged reproducible Flux ROCm runtime builder script", () => {
    const script = readFileSync(join(repoRoot, "scripts", "build-flux-rocm-runtime.cjs"), "utf8");
    const fluxAssetsSource = readFileSync(join(repoRoot, "src", "main", "inpainting", "fluxAssets.ts"), "utf8");

    expect(script).toContain("build.log");
    expect(script).toContain("environment.json");
    expect(script).toContain("mgt-flux-rocm-runtime.json");
    expect(script).toContain("mgt-flux-rocm-win-x64-rocm");
    expect(script).toContain("stable-diffusion-cpp-python");
    expect(script).toContain("--no-build-isolation");
    expect(script).toContain("--force-reinstall");
    expect(script).toContain("rocm_sdk_core");
    expect(script).toContain("rocm_sdk_libraries_custom");
    expect(script).toContain("CMAKE_ARGS");
    expect(script).toContain("-DSD_HIPBLAS=ON");
    expect(script).toContain("x86_64-pc-windows-msvc");
    expect(script).toContain("CMAKE_C_STANDARD_LIBRARIES");
    expect(script).toContain("LDFLAGS");
    expect(script).toContain("GPU_TARGETS");
    expect(script).toContain("SHA256");

    for (const target of ["gfx1030", "gfx1100", "gfx1101", "gfx1102", "gfx1151", "gfx1200", "gfx1201"]) {
      expect(script).toContain(target);
      expect(fluxAssetsSource).toContain(target);
    }
  });

  it("discovers Windows SDK and MSVC import libraries for ROCm source builds", () => {
    if (process.platform !== "win32") {
      return;
    }
    const root = join(tmpdir(), `mgt-native-build-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
      join(sdkRoot, "Include", sdkVersion, "um")
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const lib of ["kernel32.lib", "user32.lib", "gdi32.lib", "shell32.lib", "ole32.lib", "uuid.lib", "advapi32.lib"]) {
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
    for (const lib of ["oldnames.lib", "msvcrt.lib", "msvcrtd.lib", "vcruntime.lib"]) {
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
    const fluxAssetsSource = readFileSync(join(repoRoot, "src", "main", "inpainting", "fluxAssets.ts"), "utf8");
    const workerSource = readFileSync(join(repoRoot, "src", "main", "runtime", "flux-klein-sdcpp-worker.py"), "utf8");

    expect(fluxAssetsSource).toContain("Flux Klein 4B GGUF");
    expect(fluxAssetsSource).toContain("FLUX_SDCPP_WORKER");
    expect(fluxAssetsSource).toContain("--diffusion-model");
    expect(fluxAssetsSource).toContain("--vae");
    expect(fluxAssetsSource).toContain("--llm");
    expect(fluxAssetsSource).toContain("stable-diffusion-cpp-python");
    expect(workerSource).toContain("from stable_diffusion_cpp import StableDiffusion");
    expect(workerSource).toContain("diffusion_model_path");
    expect(workerSource).toContain("llm_path");
    expect(workerSource).toContain("vae_path");
    expect(workerSource).toContain("mask_image");
    expect(workerSource).not.toContain("GGUFQuantizationConfig");
    expect(workerSource).not.toContain("Flux2Transformer2DModel");
    expect(workerSource).not.toContain("--gguf-transformer");
  });

  it("invalidates cached Flux Python workers when the bundled worker changes", () => {
    const fluxAssetsSource = readFileSync(join(repoRoot, "src", "main", "inpainting", "fluxAssets.ts"), "utf8");

    expect(fluxAssetsSource).toContain("workerHash");
    expect(fluxAssetsSource).toContain("sha256FileSync(workerPath) === sha256FileSync(sourceWorker)");
    expect(fluxAssetsSource).not.toContain('"-m", "venv"');
    expect(fluxAssetsSource).not.toContain("Flux Python 가상환경을 생성합니다.");
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
      const layout = resolveFluxPythonRuntimeLayout(baseRuntimeDir, "python-rocm");
      const longRocmEntry = join(
        layout.packageDir,
        "_rocm_sdk_libraries_custom",
        "bin",
        "hipblaslt",
        "library",
        "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co"
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
        "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co"
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
    process.env.LOCALAPPDATA = "C:\\Users\\very-long-user-name-for-testing\\AppData\\Local";
    try {
      const baseRuntimeDir = "D:\\mgt\\data\\models\\inpainting\\mgt-flux-klein-runtime";
      const layout = resolveFluxPythonRuntimeLayout(baseRuntimeDir, "python-rocm");
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
        "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co"
      );

      expect(layout.packageDir).toBe(`${join("D:\\mgt\\data", "fx", "r721", "p")}`);
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
      "python-rocm"
    );

    expect(layout.runtimeDir).toBe("R:\\mgtflux\\r721");
    expect(layout.packageDir).toBe(`${join("R:\\mgtflux\\r721", "p")}`);
  });
});
