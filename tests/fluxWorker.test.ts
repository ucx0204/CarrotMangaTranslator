import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildRuntimePathEnv, sanitizeFluxRuntimeStderr } from "../src/main/inpainting/fluxWorker";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
  it("prefers the Flux CUDA 12.9 runtime before CUDA 12.8 and bundled CUDA 12.4 fallbacks", () => {
    const { exe, cuda129, cuda128, beellama } = createTempToolsLayout();
    const pathParts = buildRuntimePathEnv(exe).split(delimiter);

    expect(pathParts).toContain(cuda129);
    expect(pathParts).toContain(cuda128);
    expect(pathParts).toContain(beellama);
    expect(pathParts.indexOf(cuda129)).toBeLessThan(pathParts.indexOf(cuda128));
    expect(pathParts.indexOf(cuda128)).toBeLessThan(pathParts.indexOf(beellama));
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
});
