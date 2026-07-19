import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLUX_MODEL_REVISION,
  FLUX_MODEL_SHA256,
  FLUX_VAE_REVISION,
  FLUX_VAE_SHA256,
} from "../src/main/inpainting/fluxAssets/constants";
import { hfResolveUrl } from "../src/main/inpainting/fluxAssets/downloads";
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

  it("builds both runners with a Metal feature and exposes device preflight", () => {
    for (const runner of [
      "mgt-koharu-inpaint-runner",
      "mgt-flux-klein-runner",
    ]) {
      const cargo = readFileSync(
        join(process.cwd(), "tools", runner, "Cargo.toml"),
        "utf8",
      );
      const source = readFileSync(
        join(process.cwd(), "tools", runner, "src", "main.rs"),
        "utf8",
      );
      expect(cargo).toMatch(/^metal\s*=\s*\["koharu-ml\/metal"\]/m);
      expect(source).toContain("--capabilities");
      expect(source).toContain("Device::new_metal(0)");
      expect(source).toContain('"protocol_version": 1');
      if (runner === "mgt-flux-klein-runner") {
        expect(source).toContain("--protocol-smoke");
        expect(source).toContain("if cli.require_metal");
        expect(source).toContain(".image_to_image(&image, &options)");
        expect(source).toContain(".inpaint(&image, &mask_image, &options)");
      }
    }
  });
});
