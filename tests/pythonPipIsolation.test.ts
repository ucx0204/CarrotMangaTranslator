import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildBootstrapPythonEnv } from "../src/main/inpainting/fluxAssets/pythonBootstrap";
import { buildTargetPythonEnv } from "../src/main/inpainting/fluxAssets/rocmRuntime";
import { buildOcrRuntimeEnv } from "./helpers/runtimeModelContracts";

const { buildIsolatedPipEnvironment, resolvePipNullConfigPath } =
  require("../src/main/runtime/python-pip-environment.cjs") as {
    buildIsolatedPipEnvironment: (
      baseEnv?: NodeJS.ProcessEnv,
      managedPipEnv?: NodeJS.ProcessEnv,
    ) => NodeJS.ProcessEnv;
    resolvePipNullConfigPath: (platform?: NodeJS.Platform) => string;
  };
const { resolveOcrVenvBinDir } =
  require("../src/main/runtime/ocr/runtime-environment.cjs") as {
    resolveOcrVenvBinDir: (
      venvDir: string,
      platform?: NodeJS.Platform,
    ) => string;
  };

const pipEnvKeys = [
  "PIP_CONFIG_FILE",
  "PIP_INDEX_URL",
  "PIP_EXTRA_INDEX_URL",
  "PIP_TRUSTED_HOST",
  "PIP_TARGET",
];
const savedPipEnv = new Map<string, string | undefined>();

describe("managed Python pip isolation", () => {
  afterEach(() => {
    for (const [key, value] of savedPipEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedPipEnv.clear();
  });

  it("uses Python's exact null-config spelling on each platform", () => {
    expect(resolvePipNullConfigPath("win32")).toBe("nul");
    expect(resolvePipNullConfigPath("darwin")).toBe("/dev/null");
    expect(resolvePipNullConfigPath("linux")).toBe("/dev/null");
  });

  it("resolves managed OCR virtual-environment bins on both platforms", () => {
    expect(resolveOcrVenvBinDir("C:/managed/venv", "win32")).toBe(
      join("C:/managed/venv", "Scripts"),
    );
    expect(resolveOcrVenvBinDir("/managed/venv", "linux")).toBe(
      join("/managed/venv", "bin"),
    );
  });

  it("removes inherited pip controls while preserving app-owned settings", () => {
    const env = buildIsolatedPipEnvironment(
      {
        HTTPS_PROXY: "http://proxy.example",
        PIP_CONFIG_FILE: "C:/Users/example/pip.ini",
        PIP_INDEX_URL: "https://private.example/simple",
        PIP_EXTRA_INDEX_URL: "https://pypi.ngc.nvidia.com",
        PIP_TRUSTED_HOST: "pypi.ngc.nvidia.com",
        PIP_TARGET: "C:/unexpected-target",
      },
      { PIP_CACHE_DIR: "C:/managed/cache" },
    );

    expect(env).toMatchObject({
      HTTPS_PROXY: "http://proxy.example",
      PIP_CONFIG_FILE: resolvePipNullConfigPath(),
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INPUT: "1",
      PIP_CACHE_DIR: "C:/managed/cache",
    });
    expect(env.PIP_INDEX_URL).toBeUndefined();
    expect(env.PIP_EXTRA_INDEX_URL).toBeUndefined();
    expect(env.PIP_TRUSTED_HOST).toBeUndefined();
    expect(env.PIP_TARGET).toBeUndefined();
  });

  it("isolates Flux bootstrap and target installs from host pip settings", () => {
    poisonHostPipEnvironment();
    const runtimeDir = join("C:/data", "flux-runtime");

    assertIsolatedPipEnv(buildBootstrapPythonEnv(runtimeDir), runtimeDir);
    assertIsolatedPipEnv(
      buildTargetPythonEnv(runtimeDir, join(runtimeDir, "python-packages")),
      runtimeDir,
    );
  });

  it("isolates OCR package installs from host and machine pip configs", () => {
    poisonHostPipEnvironment();
    const runtimeDir = join("C:/data", "ocr-runtime");
    const env = buildOcrRuntimeEnv(
      { ocrDevice: "cpu" },
      { runtimeDir, includePackageDir: false },
    );

    expect(env.PIP_CONFIG_FILE).toBe(resolvePipNullConfigPath());
    expect(env.PIP_DISABLE_PIP_VERSION_CHECK).toBe("1");
    expect(env.PIP_NO_INPUT).toBe("1");
    expect(env.PIP_INDEX_URL).toBeUndefined();
    expect(env.PIP_EXTRA_INDEX_URL).toBeUndefined();
    expect(env.PIP_TRUSTED_HOST).toBeUndefined();
    expect(env.PIP_TARGET).toBeUndefined();
    expect(env.PIP_CACHE_DIR).toBe(join(runtimeDir, "pip-cache"));
  });
});

function poisonHostPipEnvironment(): void {
  const values: Record<string, string> = {
    PIP_CONFIG_FILE: "C:/Users/example/pip.ini",
    PIP_INDEX_URL: "https://private.example/simple",
    PIP_EXTRA_INDEX_URL: "https://pypi.ngc.nvidia.com",
    PIP_TRUSTED_HOST: "pypi.ngc.nvidia.com",
    PIP_TARGET: "C:/unexpected-target",
  };
  for (const [key, value] of Object.entries(values)) {
    if (!savedPipEnv.has(key)) {
      savedPipEnv.set(key, process.env[key]);
    }
    process.env[key] = value;
  }
}

function assertIsolatedPipEnv(
  env: NodeJS.ProcessEnv,
  runtimeDir: string,
): void {
  expect(env.PIP_CONFIG_FILE).toBe(resolvePipNullConfigPath());
  expect(env.PIP_DISABLE_PIP_VERSION_CHECK).toBe("1");
  expect(env.PIP_NO_INPUT).toBe("1");
  expect(env.PIP_CACHE_DIR).toBe(join(runtimeDir, "pip-cache"));
  for (const key of pipEnvKeys.slice(1)) {
    expect(env[key]).toBeUndefined();
  }
}
