import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readBakedBuildChannel,
  resolveBuildChannel,
} from "../src/main/buildChannel";
import { buildRuntimeCapabilities } from "../src/main/runtimeCapabilities";

describe("build channel", () => {
  it("uses the alpha channel only for Apple Silicon unless explicitly overridden", () => {
    expect(resolveBuildChannel("darwin", "arm64", undefined)).toBe("mac-alpha");
    expect(resolveBuildChannel("darwin", "x64", undefined)).toBe("stable");
    expect(resolveBuildChannel("win32", "x64", undefined)).toBe("stable");
    expect(resolveBuildChannel("darwin", "arm64", "stable")).toBe("stable");
    expect(resolveBuildChannel("darwin", "arm64", undefined, "stable")).toBe(
      "stable",
    );
    expect(resolveBuildChannel("darwin", "arm64", "mac-alpha", "stable")).toBe(
      "mac-alpha",
    );
  });

  it("reads a packaged build channel from baked package metadata", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "mgt-build-channel-"));
    const packageJsonPath = join(fixtureRoot, "package.json");
    try {
      writeFileSync(packageJsonPath, '{"buildChannel":"stable"}', "utf8");
      expect(readBakedBuildChannel(packageJsonPath)).toBe("stable");
      writeFileSync(packageJsonPath, '{"buildChannel":"unknown"}', "utf8");
      expect(readBakedBuildChannel(packageJsonPath)).toBeUndefined();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("runtime capabilities", () => {
  it("reports Metal, MLX GPU OCR, and unified-memory limits on Apple Silicon", () => {
    const capabilities = buildRuntimeCapabilities({
      platform: "darwin",
      arch: "arm64",
      gpu: {
        name: "Apple M2 Max",
        memoryMb: 32 * 1024,
        unifiedMemoryMb: 32 * 1024,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "apple",
        supportsMetal: true,
      },
    });

    expect(capabilities.buildChannel).toBe("mac-alpha");
    expect(capabilities.supportsMetal).toBe(true);
    expect(capabilities.unifiedMemoryMb).toBe(32 * 1024);
    expect(capabilities.localGemma.minimumUnifiedMemoryMb).toEqual({
      minimum12b: 16 * 1024,
      economy26b: 24 * 1024,
      full31b: 32 * 1024,
    });
    expect(capabilities.inpainting.fluxKlein).toMatchObject({
      metal: true,
      cpuFallback: false,
      minimumUnifiedMemoryMb: 16 * 1024,
    });
    expect(capabilities.ocr).toEqual({ cpu: true, gpu: true });
  });

  it("preserves the existing Windows capability surface", () => {
    const capabilities = buildRuntimeCapabilities({
      platform: "win32",
      arch: "x64",
      gpu: {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24 * 1024,
        rtxGeneration: 40,
        computeCapability: 8.9,
        vendor: "nvidia",
      },
    });

    expect(capabilities.buildChannel).toBe("stable");
    expect(capabilities.localGemma.available).toBe(true);
    expect(capabilities.supportsMetal).toBe(false);
    expect(capabilities.unifiedMemoryMb).toBeNull();
    expect(capabilities.ocr).toEqual({ cpu: true, gpu: true });
  });
});
