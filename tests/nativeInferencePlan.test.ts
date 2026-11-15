import { describe, expect, it } from "vitest";
import catalog from "../src/main/runtime/native-inference-manifest.json";
import { nativeInferencePlan } from "../src/main/runtimeSupport/nativeInferencePlan";

describe("Koharu native runtime plans", () => {
  it("installs an isolated Vulkan diffusion runner without CUDA or ROCm packages", () => {
    const plan = nativeInferencePlan({
      engine: "diffusion",
      backend: "vulkan",
      platform: "win32",
      arch: "x64",
    });
    expect(plan.packages.map((asset) => asset.id)).toEqual([
      "msvc-win32",
      "diffusion-win32-vulkan",
    ]);
    expect(plan.executable).toBe("mgt-flux-klein-vulkan.exe");
    expect(plan.packages[1].only).toEqual([
      "stable-diffusion.dll",
      plan.executable,
    ]);
    expect(plan.libraries).not.toContain(plan.executable);
    for (const engine of ["torch", "rocm-probe"] as const) {
      expect(() =>
        nativeInferencePlan({
          engine,
          backend: "vulkan",
          platform: "win32",
          arch: "x64",
        }),
      ).toThrow();
    }
    expect(() =>
      nativeInferencePlan({
        engine: "diffusion",
        backend: "vulkan",
        platform: "darwin",
        arch: "arm64",
      }),
    ).toThrow();
  });
  it("pins every downloadable package to a digest and exact length", () => {
    for (const asset of Object.values(catalog.packages)) {
      expect(asset.url).toMatch(/^https:\/\//);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.bytes).toBeGreaterThan(0);
    }
  });
  it("keeps GPU dependencies separate from the CPU runtime", () => {
    const cpu = nativeInferencePlan({
      engine: "torch",
      backend: "cpu",
      platform: "win32",
      arch: "x64",
    });
    expect(cpu.libraries).toContain("torch_cpu.dll");
    expect(cpu.libraries).not.toContain("torch_cuda.dll");
    const cuda = nativeInferencePlan({
      engine: "torch",
      backend: "cuda",
      platform: "win32",
      arch: "x64",
    });
    expect(cuda.libraries.indexOf("cudart64_13.dll")).toBeLessThan(
      cuda.libraries.indexOf("torch_cuda.dll"),
    );
    expect(
      cuda.packages.find((asset) => asset.id === "torch-win32-cpu")?.only,
    ).toEqual(["libiomp5md.dll"]);
  });
  it("uses exact AMD targets and a core-only probe", () => {
    const probe = nativeInferencePlan({
      engine: "rocm-probe",
      backend: "rocm",
      platform: "win32",
      arch: "x64",
    });
    expect(probe.packages.some((asset) => asset.id === "rocm-libraries")).toBe(
      false,
    );
    const rocm = nativeInferencePlan({
      engine: "diffusion",
      backend: "rocm",
      platform: "win32",
      arch: "x64",
      rocmTarget: "gfx1100",
    });
    expect(
      rocm.packages.some((asset) => asset.id === "rocm-device-gfx1100"),
    ).toBe(true);
    for (const target of [undefined, "gfx110X", "gfx9999"]) {
      expect(() =>
        nativeInferencePlan({
          engine: "torch",
          backend: "rocm",
          platform: "win32",
          arch: "x64",
          rocmTarget: target,
        }),
      ).toThrow();
    }
  });
  it("uses the Apple Silicon library for Metal or CPU and rejects unsupported hosts", () => {
    for (const backend of ["metal", "cpu"] as const) {
      expect(
        nativeInferencePlan({
          engine: "diffusion",
          backend,
          platform: "darwin",
          arch: "arm64",
        }).libraries,
      ).toEqual(["libstable-diffusion.dylib"]);
    }
    expect(() =>
      nativeInferencePlan({
        engine: "torch",
        backend: "metal",
        platform: "win32",
        arch: "x64",
      }),
    ).toThrow();
    expect(() =>
      nativeInferencePlan({
        engine: "torch",
        backend: "cpu",
        platform: "linux",
        arch: "x64",
      }),
    ).toThrow();
  });
});
