import { qwenWorkerEnvironment } from "../src/main/inpainting/qwenGpuBudget";
import { beforeEach, expect, it, vi } from "vitest";
import {
  prepareQwenPlatformGpu,
  qwenNativeDevice,
} from "../src/main/inpainting/qwenPlatformGpu";
import { nativeInferencePlan } from "../src/main/runtimeSupport/nativeInferencePlan";

const { execute, adapters } = vi.hoisted(() => ({
  execute: vi.fn(),
  adapters: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(adapters, {
    [Symbol.for("nodejs.util.promisify.custom")]: execute,
  }),
}));
const signal = new AbortController().signal;
const luid = "000000000000abcd",
  name = "AMD Radeon RX 7900 XTX";
const board = (mib: number) => ({
  Name: "luid_0x00000000_0x0000ABCD_phys_0",
  DedicatedUsage: mib * 2 ** 20,
});
beforeEach(() => {
  execute.mockReset();
  adapters
    .mockReset()
    .mockImplementation((_file, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          adapters: [
            {
              name,
              luid,
              dedicatedVideoMemory: 12 * 2 ** 30,
              deviceId: 0,
              highPerformanceRank: 0,
            },
          ],
          cudaLuid: null,
        }),
      );
    });
});

it("uses the enumerated GPU key and rejects missing devices and CPU-only runtimes", () => {
  const devices = "CPU\tx86\nROCm0\tAMD Radeon\nROCm1\tAMD Radeon Pro\n";
  expect(qwenNativeDevice(devices, "rocm", 1)).toEqual({
    key: "ROCm1",
    name: "AMD Radeon Pro",
    matchingBoards: 1,
  });
  expect(qwenNativeDevice("MTL0\tApple M4 Pro", "metal").key).toBe("MTL0");
  expect(() => qwenNativeDevice(devices, "vulkan")).toThrow();
  expect(() => qwenNativeDevice(devices, "rocm", 2)).toThrow();
});
it.each([
  ["vulkan", "win32", "x64", "ggml-vulkan.dll"],
  ["rocm", "win32", "x64", "hipblas.dll"],
  ["metal", "darwin", "arm64", "libstable-diffusion.dylib"],
] as const)(
  "binds the %s executable, libraries and device kernels",
  (backend, platform, arch, library) => {
    const plan = nativeInferencePlan({
      engine: "qwen-image",
      backend,
      platform,
      arch,
      rocmTarget: "gfx1100",
    });
    expect(plan.executable).toBe(
      platform === "win32" ? "sd-cli.exe" : "sd-cli",
    );
    expect(plan.libraries.some((file) => file.endsWith(library))).toBe(true);
    expect(
      plan.packages.some(
        (item) =>
          item.id.startsWith("qwen-image-sdcpp") &&
          item.only?.includes(plan.executable ?? ""),
      ),
    ).toBe(true);
    expect(
      plan.packages.map((item) => item.id).includes("qwen-rocm-device-gfx1100"),
    ).toBe(backend === "rocm");
    expect(plan.libraries).not.toContain("ggml-cuda.dll");
  },
);
it("uses the matched HIP core for the exact GPU probe and rejects missing target kernels", () => {
  const options = { platform: "win32", arch: "x64", backend: "rocm" } as const;
  const probe = nativeInferencePlan({
    ...options,
    engine: "rocm-probe",
    qwenRocmProbe: true,
  });
  expect(probe.packages.at(-1)?.only).toContain("amdhip64_7.dll");
  expect(() =>
    nativeInferencePlan({
      ...options,
      engine: "qwen-image",
      rocmTarget: "gfx9999",
    }),
  ).toThrow(/Vulkan/);
});
it("checks the selected WDDM board and yields to another active image worker", async () => {
  execute
    .mockResolvedValueOnce({ stdout: "Vulkan0\t" + name })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ board: [board(2000)], peer: false }),
    })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ board: [board(2400)], peer: true }),
    });
  const guard = await prepareQwenPlatformGpu("sd-cli", {}, "vulkan", 0, signal);
  await guard.wait(signal);
  const stop = vi.fn();
  expect(await guard.monitor(42, new Promise(() => {}), stop)).toBe(
    "inference",
  );
  expect(stop).toHaveBeenCalledOnce();
  expect(adapters).toHaveBeenCalledOnce();
});
it("stops the owned worker before the 11 GiB limit and fails closed when counters disappear", async () => {
  execute
    .mockResolvedValueOnce({ stdout: "ROCm0\t" + name })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ board: [board(10500)], peer: false }),
    })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ board: [], peer: false }),
    });
  const guard = await prepareQwenPlatformGpu("sd-cli", {}, "rocm", 0, signal);
  const stop = vi.fn();
  expect(await guard.monitor(42, new Promise(() => {}), stop)).toBe("memory");
  await expect(guard.monitor(42, new Promise(() => {}), stop)).rejects.toThrow(
    /메모리/,
  );
  expect(stop).toHaveBeenCalledTimes(2);
});
it("reads Metal unified memory and recognizes an active external renderer", async () => {
  execute
    .mockResolvedValueOnce({ stdout: "MTL0\tApple M4" })
    .mockResolvedValueOnce({ stdout: '"In use system memory"=1024' })
    .mockResolvedValueOnce({
      stdout: "  42 2.1 sd-cli own\n  20 11.2 /bin/sd-cli -r art.png",
    });
  const guard = await prepareQwenPlatformGpu("sd-cli", {}, "metal");
  const stop = vi.fn();
  expect(await guard.monitor(42, new Promise(() => {}), stop)).toBe(
    "inference",
  );
  expect(stop).toHaveBeenCalledOnce();
});

it.each([1, 2])(
  "separates unmeasured display aliases from %i physical boards",
  async (count) => {
    const physical = {
      name,
      luid,
      dedicatedVideoMemory: 12 * 2 ** 30,
      deviceId: 0,
      highPerformanceRank: 0,
    };
    adapters.mockImplementation((_file, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          adapters: [
            physical,
            {
              ...physical,
              luid: "000000000000cdef",
              deviceId: 1,
              highPerformanceRank: 1,
            },
          ],
          cudaLuid: null,
        }),
      );
    });
    execute
      .mockResolvedValueOnce({
        stdout: Array.from(
          { length: count },
          (_, index) => "Vulkan" + index + "\t" + name,
        ).join("\n"),
      })
      .mockResolvedValue({
        stdout: JSON.stringify({ board: [board(4300)], peer: false }),
      });
    const guard = await prepareQwenPlatformGpu(
      "sd-cli",
      {},
      "vulkan",
      0,
      signal,
    );
    if (count === 1) await expect(guard.wait(signal)).resolves.toBeUndefined();
    else await expect(guard.wait(signal)).rejects.toThrow(/메모리/);
  },
);

it("uses the same physical HIP ordinals when probing and launching, preserving caller visibility", async () => {
  vi.stubEnv("HIP_VISIBLE_DEVICES", "4");
  vi.stubEnv("ROCR_VISIBLE_DEVICES", "3");
  try {
    const native = qwenWorkerEnvironment({ HIP_PATH: "verified-sdk" });
    expect(native.HIP_VISIBLE_DEVICES).toBeUndefined();
    expect(native.ROCR_VISIBLE_DEVICES).toBeUndefined();
    expect(qwenWorkerEnvironment({}).HIP_VISIBLE_DEVICES).toBe("4");
    expect(qwenWorkerEnvironment({}, "GPU-selected").CUDA_VISIBLE_DEVICES).toBe(
      "GPU-selected",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
it("refuses a Vulkan device unrecognized by DXGI", async () => {
  execute.mockResolvedValueOnce({ stdout: "Vulkan0\tAnother adapter" });
  await expect(
    prepareQwenPlatformGpu("sd-cli", {}, "vulkan", 0, signal),
  ).rejects.toThrow(/메모리/);
});
