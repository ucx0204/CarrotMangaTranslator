import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureFluxWorkerLaunch,
  shouldUseLegacyFluxDiffusersCpu,
} from "../src/main/inpainting/fluxAssets/workerLaunch";
import {
  FLUX_CPU_RUNNER_ARCHIVE_BYTES,
  FLUX_CPU_RUNNER_ARCHIVE_SHA256,
  FLUX_CPU_RUNNER_ASSET_FILE,
  FLUX_CPU_RUNNER_DIR,
  FLUX_CPU_RUNNER_RELEASE_TAG,
  FLUX_CUDA_RUNTIME_DIR,
} from "../src/main/inpainting/fluxAssets/constants";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const tempDirs: string[] = [];
const repoRoot = join(__dirname, "..");
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.MGT_FLUX_KLEIN_CPU_EXE;
  delete process.env.MGT_FLUX_KLEIN_TOOLS_DIR;
  delete process.env.MGT_FLUX_DISABLE_REMOTE_CPU_RUNNER_DOWNLOAD;
  delete process.env.MGT_FLUX_KLEIN_CPU_RUNNER_BASE_URL;
  delete process.env.MGT_FLUX_KLEIN_CPU_RUNNER_BYTES;
  delete process.env.MGT_FLUX_KLEIN_CPU_RUNNER_SHA256;
  delete process.env.MGT_FLUX_KLEIN_CPU_EXE_BYTES;
  delete process.env.MGT_FLUX_KLEIN_CPU_EXE_SHA256;
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
      join(runtimeDir, FLUX_CPU_RUNNER_DIR, "mgt-flux-klein-cpu.exe"),
    );
    expect(readFileSync(launch.executable, "utf8")).toBe("cpu-only-runner");
    expect(existsSync(join(runtimeDir, FLUX_CUDA_RUNTIME_DIR))).toBe(false);
  });

  it("downloads and verifies the pinned CPU-only runner when it is not local", async () => {
    const runtimeDir = createTempDir("mgt-flux-cpu-remote-runtime-");
    const toolsDir = createTempDir("mgt-flux-cpu-remote-tools-");
    const assetDir = createTempDir("mgt-flux-cpu-remote-assets-");
    const executable = Buffer.from("remote-cpu-only-runner");
    const archivePath = join(assetDir, FLUX_CPU_RUNNER_ASSET_FILE);
    const zip = new AdmZip();
    zip.addFile("mgt-flux-klein-cpu.exe", executable);
    zip.writeZip(archivePath);
    const archive = readFileSync(archivePath);
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    const executableSha256 = createHash("sha256")
      .update(executable)
      .digest("hex");
    const server = createServer((request, response) => {
      const requestPath = new URL(request.url || "/", "http://127.0.0.1")
        .pathname;
      if (requestPath !== `/${FLUX_CPU_RUNNER_ASSET_FILE}`) {
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
    process.env.MGT_FLUX_KLEIN_CPU_RUNNER_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.MGT_FLUX_KLEIN_CPU_RUNNER_BYTES = String(archive.length);
    process.env.MGT_FLUX_KLEIN_CPU_RUNNER_SHA256 = archiveSha256;
    process.env.MGT_FLUX_KLEIN_CPU_EXE_BYTES = String(executable.length);
    process.env.MGT_FLUX_KLEIN_CPU_EXE_SHA256 = executableSha256;
    process.env.MANGA_TRANSLATOR_LOG_PATH = join(runtimeDir, "app.log");

    try {
      const launch = await ensureFluxWorkerLaunch({
        runtimeDir,
        modelDir: createTempDir("mgt-flux-cpu-remote-model-"),
        backend: "cpu-native",
      });
      expect(launch.executable).toBe(
        join(runtimeDir, FLUX_CPU_RUNNER_DIR, "mgt-flux-klein-cpu.exe"),
      );
      expect(readFileSync(launch.executable, "utf8")).toBe(
        "remote-cpu-only-runner",
      );
      expect(
        existsSync(
          join(runtimeDir, FLUX_CPU_RUNNER_DIR, ".mgt-flux-cpu-runner.json"),
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
    expect(packageJson.scripts?.["package:flux-cpu-runner"]).toContain(
      "package-flux-klein-cpu-release.cjs",
    );
    const buildScript = readFileSync(
      join(repoRoot, "scripts", "prepare-flux-klein-cpu-runner.cjs"),
      "utf8",
    );
    expect(buildScript).toContain('"--no-default-features"');
    expect(buildScript).toContain('LLAMA_CPP_TAG: "b-mgt-unused"');
    expect(buildScript).toContain('capabilities.backend !== "cpu-native"');
    const releaseScript = readFileSync(
      join(repoRoot, "scripts", "package-flux-klein-cpu-release.cjs"),
      "utf8",
    );
    expect(releaseScript).toContain(FLUX_CPU_RUNNER_RELEASE_TAG);
    expect(releaseScript).toContain(FLUX_CPU_RUNNER_ASSET_FILE);
    expect(FLUX_CPU_RUNNER_ARCHIVE_BYTES).toBe(22_500_917);
    expect(FLUX_CPU_RUNNER_ARCHIVE_SHA256).toBe(
      "4eed6d48de73e4f7c9d3fb646cf99fa5147dcf145789ec864a6db2b25a413e87",
    );
  });
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
