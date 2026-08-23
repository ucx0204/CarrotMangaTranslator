import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsHipSdkProbeLogDetail,
  discoverWindowsHipSdk,
  formatWindowsHipSdkProbeError,
} from "../src/main/inpainting/fluxAssets/hipSdk";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Windows HIP SDK discovery", () => {
  it("prefers an explicit HIP_PATH and accepts HIP_PATH pointing at bin", async () => {
    const hipRoot = createHipSdk("explicit-hip", "amdhip64_7.dll");
    const rocmRoot = createHipSdk("explicit-rocm", "amdhip64_6.dll");

    const fromRoot = await discoverWindowsHipSdk({
      env: { HIP_PATH: hipRoot, ROCM_PATH: rocmRoot, PATH: "" },
      platform: "win32",
      standardRoots: [],
    });
    expect(fromRoot.sdk).toMatchObject({
      rootDir: hipRoot,
      binDir: join(hipRoot, "bin"),
      source: "HIP_PATH",
      version: "7",
    });

    const fromBin = await discoverWindowsHipSdk({
      env: { HIP_PATH: join(hipRoot, "bin"), PATH: "" },
      platform: "win32",
      standardRoots: [],
    });
    expect(fromBin.sdk).toMatchObject({
      rootDir: hipRoot,
      binDir: join(hipRoot, "bin"),
      source: "HIP_PATH",
    });
  });

  it("accepts ROCM_PATH and a HIP bin directory already present on PATH", async () => {
    const rocmRoot = createHipSdk("rocm-path", "amdhip64_7.dll");
    const pathRoot = createHipSdk("system-path", "amdhip64_7.dll");

    const fromRocm = await discoverWindowsHipSdk({
      env: { ROCM_PATH: rocmRoot, PATH: "" },
      platform: "win32",
      standardRoots: [],
    });
    expect(fromRocm.sdk?.source).toBe("ROCM_PATH");
    expect(fromRocm.sdk?.rootDir).toBe(rocmRoot);

    const fromPath = await discoverWindowsHipSdk({
      env: { PATH: join(pathRoot, "bin") },
      platform: "win32",
      standardRoots: [],
    });
    expect(fromPath.sdk).toMatchObject({
      source: "PATH",
      rootDir: pathRoot,
      binDir: join(pathRoot, "bin"),
    });
  });

  it("discovers a versioned SDK below an explicit HIP_PATH base", async () => {
    const hipBase = createTempDir("explicit-versioned-hip");
    writeHipRuntime(join(hipBase, "7.2"), "amdhip64_7.dll");

    const probe = await discoverWindowsHipSdk({
      env: { HIP_PATH: hipBase, PATH: "" },
      platform: "win32",
      standardRoots: [],
    });

    expect(probe.sdk).toMatchObject({
      source: "HIP_PATH",
      rootDir: join(hipBase, "7.2"),
      binDir: join(hipBase, "7.2", "bin"),
      version: "7.2",
    });
  });

  it("ignores a driver-only HIP DLL in a non-SDK PATH directory", async () => {
    const systemRuntimeDir = createTempDir("system32-runtime");
    const runtimeDllPath = join(systemRuntimeDir, "amdhip64_7.dll");
    writeFileSync(runtimeDllPath, "hip-runtime");
    const env = { PATH: systemRuntimeDir };

    const probe = await discoverWindowsHipSdk({
      env,
      platform: "win32",
      standardRoots: [],
    });
    const detail = buildWindowsHipSdkProbeLogDetail(probe, env);
    const error = formatWindowsHipSdkProbeError(probe);

    expect(probe.sdk).toBeNull();
    expect(probe.searchedBinDirs).toEqual([]);
    expect(probe.ignoredNonSdkRuntimeDlls).toEqual([runtimeDllPath]);
    expect(detail.ignoredNonSdkRuntimeDlls).toEqual([runtimeDllPath]);
    expect(detail.ignoredNonSdkRuntimeDllCount).toBe(1);
    expect(detail.sdk).toBeNull();
    expect(error.message).toContain("SDK bin 구조가 아닌 PATH 위치");
    expect(error.message).toContain(runtimeDllPath);
  });

  it("prefers a standard SDK installation over an SDK bin directory on PATH", async () => {
    const standardRoot = createHipSdk("standard-hip", "amdhip64_7.dll");
    const pathRoot = createHipSdk("path-hip", "amdhip64_6.dll");

    const probe = await discoverWindowsHipSdk({
      env: { PATH: join(pathRoot, "bin") },
      platform: "win32",
      standardRoots: [standardRoot],
    });

    expect(probe.sdk).toMatchObject({
      source: "standard",
      rootDir: standardRoot,
      binDir: join(standardRoot, "bin"),
    });
  });

  it("discovers the newest installed ROCm version instead of a hardcoded list", async () => {
    const rocmBase = createTempDir("versioned-rocm");
    writeHipRuntime(join(rocmBase, "7.1"), "amdhip64_7.dll");
    writeHipRuntime(join(rocmBase, "7.2.0"), "amdhip64_7.dll");
    writeHipRuntime(join(rocmBase, "6.4"), "amdhip64_6.dll");

    const probe = await discoverWindowsHipSdk({
      env: { PATH: "" },
      platform: "win32",
      standardRoots: [rocmBase],
    });

    expect(probe.sdk).toMatchObject({
      source: "standard",
      rootDir: join(rocmBase, "7.2.0"),
      version: "7.2.0",
    });
  });

  it("reports every checked location and incompatible runtime DLL before launch", async () => {
    const invalidRoot = createTempDir("invalid-hip");
    writeHipRuntime(invalidRoot, "amdhip64_8.dll");

    const probe = await discoverWindowsHipSdk({
      env: { HIP_PATH: invalidRoot, PATH: "" },
      platform: "win32",
      standardRoots: [],
    });
    const error = formatWindowsHipSdkProbeError(probe);

    expect(probe.sdk).toBeNull();
    expect(probe.searchedBinDirs).toContain(join(invalidRoot, "bin"));
    expect(probe.incompatibleRuntimeDlls).toContain(
      join(invalidRoot, "bin", "amdhip64_8.dll"),
    );
    expect(error.message).toContain("amdhip64_7.dll 또는 amdhip64_6.dll");
    expect(error.message).toContain(join(invalidRoot, "bin"));
    expect(error.message).toContain("CPU");
  });

  it("fails clearly outside Windows", async () => {
    const probe = await discoverWindowsHipSdk({
      env: {},
      platform: "darwin",
      standardRoots: [],
    });

    expect(probe.platformSupported).toBe(false);
    expect(formatWindowsHipSdkProbeError(probe).message).toContain("Windows");
  });
});

function createHipSdk(prefix: string, runtimeDll: string): string {
  const root = createTempDir(prefix);
  writeHipRuntime(root, runtimeDll);
  return root;
}

function createTempDir(prefix: string): string {
  const root = join(
    tmpdir(),
    `mgt-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeHipRuntime(root: string, runtimeDll: string): void {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, runtimeDll), runtimeDll);
}
