import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  FLUX_MODEL_REVISION,
  FLUX_MODEL_SHA256,
  FLUX_VAE_REVISION,
  FLUX_VAE_SHA256,
} from "../src/main/inpainting/fluxAssets/constants";
import { hfResolveUrl } from "../src/main/runtimeSupport/modelDownloads";
import { resolveFluxWorkerBackend } from "../src/main/inpainting/fluxAssets/workerLaunch";
import {
  buildFluxRuntimeExitError,
  sanitizeFluxRuntimeStderr,
} from "../src/main/inpainting/fluxWorkerErrors";
import {
  FLUX_RECOMMENDED_UNIFIED_MEMORY_MB,
  assertFluxMemoryPolicy,
} from "../src/main/inpainting/inpaintingEnginePool";
import { resolveKoharuBackendCandidates } from "../src/main/inpainting/koharuEnginePool";

const require = createRequire(import.meta.url);

describe("Apple Silicon inpainting policy", () => {
  it("routes both native inpainting protocols to Metal", async () => {
    expect(resolveFluxWorkerBackend("metal-native")).toBe("metal-native");
    await expect(
      resolveKoharuBackendCandidates("metal-native"),
    ).resolves.toEqual(["metal-native", "cpu"]);
  });

  it("requires an explicit Alpha opt-in for Flux below 16 GiB", () => {
    expect(FLUX_RECOMMENDED_UNIFIED_MEMORY_MB).toBe(16 * 1024);
    expect(() =>
      assertFluxMemoryPolicy({
        backend: "metal-native",
        unifiedMemoryMb: 8 * 1024,
        allowUnsafeLowMemoryFlux: false,
      }),
    ).toThrow(/16GB.*명시적으로 허용/);
    expect(() =>
      assertFluxMemoryPolicy({
        backend: "metal-native",
        unifiedMemoryMb: 8 * 1024,
        allowUnsafeLowMemoryFlux: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertFluxMemoryPolicy({
        backend: "metal-native",
        unifiedMemoryMb: 16 * 1024,
        allowUnsafeLowMemoryFlux: false,
      }),
    ).not.toThrow();
  });

  it("keeps Flux Metal failures explicit instead of silently falling back", () => {
    const error = buildFluxRuntimeExitError(
      1,
      "Metal device unavailable",
      "metal-native",
    );
    expect(error.message).toContain("CPU나 다른 모델로 자동 전환하지 않습니다");
    expect(
      sanitizeFluxRuntimeStderr(
        "/Users/alice/work/tools/mgt-flux-klein-runner/src/main.rs:42",
      ),
    ).not.toContain("alice");
  });

  it("pins native Flux assets to revisions and SHA-256 checksums", () => {
    expect(FLUX_MODEL_REVISION).toBe(
      "8342a6a97b2d18acae5d62124735c39ba23060e2",
    );
    expect(FLUX_MODEL_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(FLUX_VAE_REVISION).toBe("a3efc24f613ef42d9428af62fdbd6f5fd8856c4a");
    expect(FLUX_VAE_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      hfResolveUrl("owner/model", "weights.gguf", FLUX_MODEL_REVISION),
    ).toContain(`/resolve/${FLUX_MODEL_REVISION}/weights.gguf`);
  });

  it("builds both runners with Metal and verifies their runtime contracts", () => {
    const {
      assertFluxProtocolSmoke,
      assertMetalCapabilities,
      createMetalRunnerBuildPlan,
    } = require("../scripts/metal-runner-build-plan.cjs");
    const plan = createMetalRunnerBuildPlan(process.cwd());

    expect(plan.map((entry: { id: string }) => entry.id)).toEqual([
      "mgt-koharu-inpaint-runner",
      "mgt-flux-klein",
    ]);
    for (const entry of plan) {
      const cargo = readFileSync(entry.manifestPath, "utf8");
      expect(cargo).toMatch(/^metal\s*=\s*\["koharu-ml\/metal"\]/m);
      expect(entry.build).toEqual({
        command: "cargo",
        args: [
          "build",
          "--manifest-path",
          entry.manifestPath,
          "--locked",
          "--release",
          "--target",
          "aarch64-apple-darwin",
          "--no-default-features",
          "--features",
          "metal",
        ],
      });
      expect(entry.capabilities).toEqual({
        command: entry.binaryPath,
        args: ["--capabilities"],
      });
      expect(() =>
        assertMetalCapabilities(
          {
            protocol_version: 1,
            runner: entry.id,
            backend: "metal-native",
            metal_device: true,
            models: entry.expectedModels,
          },
          entry,
        ),
      ).not.toThrow();
    }

    const flux = plan[1];
    expect(flux.protocolSmoke).toMatchObject({
      command: flux.binaryPath,
      args: ["--protocol-smoke"],
      input: '{"type":"shutdown"}\n',
    });
    expect(() =>
      assertFluxProtocolSmoke(
        {
          protocol_version: 1,
          runner: "mgt-flux-klein",
          backend: "metal-native",
          request: "shutdown",
          ok: true,
        },
        flux,
      ),
    ).not.toThrow();
    expect(() =>
      assertMetalCapabilities(
        {
          protocol_version: 1,
          runner: "mgt-flux-klein",
          backend: "cpu",
          metal_device: false,
          models: ["flux-klein"],
        },
        flux,
      ),
    ).toThrow("Invalid Metal capability contract");
  });
});
