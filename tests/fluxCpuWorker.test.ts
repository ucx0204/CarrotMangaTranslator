import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureFluxWorkerLaunch,
  shouldUseLegacyFluxDiffusersCpu,
} from "../src/main/inpainting/fluxAssets/workerLaunch";
import { FLUX_CUDA_RUNTIME_DIR } from "../src/main/inpainting/fluxAssets/constants";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const tempDirs: string[] = [];
const repoRoot = join(__dirname, "..");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MGT_FLUX_KLEIN_CPU_EXE;
  delete process.env.MGT_FLUX_KLEIN_TOOLS_DIR;
  delete process.env.MGT_FLUX_LEGACY_DIFFUSERS_CPU;
  delete process.env.MANGA_TRANSLATOR_LOG_PATH;
});

describeWindows("Flux CPU worker runtime", () => {
  it("launches the dedicated CPU-only runner without a CUDA runtime", async () => {
    const runtimeDir = createTempDir("mgt-flux-cpu-");
    const modelDir = createTempDir("mgt-flux-model-");
    const toolsDir = createTempDir("mgt-flux-cpu-tools-");
    const sourceDir = join(toolsDir, "mgt-flux-klein-cpu");
    const sourceExe = join(sourceDir, "mgt-flux-klein-cpu.exe");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourceExe, "cpu-only-runner");
    process.env.MGT_FLUX_KLEIN_TOOLS_DIR = toolsDir;
    process.env.MANGA_TRANSLATOR_LOG_PATH = join(runtimeDir, "app.log");

    const launch = await ensureFluxWorkerLaunch({
      runtimeDir,
      modelDir,
      backend: "cpu-native",
    });

    expect(launch).toMatchObject({
      backend: "cpu-native",
      args: [],
      label: "Flux Klein CPU (매우 느린 호환 모드)",
    });
    expect(launch.executable).toBe(
      join(runtimeDir, "mgt-flux-klein-cpu", "mgt-flux-klein-cpu.exe"),
    );
    expect(readFileSync(launch.executable, "utf8")).toBe("cpu-only-runner");
    expect(existsSync(join(runtimeDir, FLUX_CUDA_RUNTIME_DIR))).toBe(false);
  });

  it("keeps legacy Diffusers CPU behind an explicit diagnostic environment variable", () => {
    expect(shouldUseLegacyFluxDiffusersCpu({})).toBe(false);
    expect(
      shouldUseLegacyFluxDiffusersCpu({ MGT_FLUX_LEGACY_DIFFUSERS_CPU: "1" }),
    ).toBe(true);
    expect(
      shouldUseLegacyFluxDiffusersCpu({
        MGT_FLUX_LEGACY_DIFFUSERS_CPU: "false",
      }),
    ).toBe(false);
  });

  it("builds and validates the packaged runner as CPU-only", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["build:flux-cpu-runner"]).toContain(
      "prepare-flux-klein-cpu-runner.cjs",
    );
    const buildScript = readFileSync(
      join(repoRoot, "scripts", "prepare-flux-klein-cpu-runner.cjs"),
      "utf8",
    );
    expect(buildScript).toContain('"--no-default-features"');
    expect(buildScript).toContain('LLAMA_CPP_TAG: "b-mgt-unused"');
    expect(buildScript).toContain('capabilities.backend !== "cpu-native"');
  });
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
