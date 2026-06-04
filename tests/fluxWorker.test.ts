import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
});
