import { describe, expect, it, vi } from "vitest";
import {
  GpuInfoDetector,
  inferAmdRocmTargetFromName,
  parseRocmSmiGpuLine,
  parseRtxGeneration,
  parseWindowsAmdGpuLine,
  resolveAmdRocmTargetFromArch,
} from "../src/main/gpuInfo";
import { buildAppleGpuInfo } from "../src/main/appleGpuInfo";

describe("Apple Silicon GPU detection", () => {
  it("reports Metal and unified system memory", () => {
    expect(buildAppleGpuInfo("Apple M3 Pro", 36 * 1024 ** 3)).toEqual({
      name: "Apple M3 Pro",
      memoryMb: 36 * 1024,
      unifiedMemoryMb: 36 * 1024,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "apple",
      rocmArch: null,
      rocmTarget: null,
      supportsRocm: false,
      supportsVulkan: false,
      supportsMetal: true,
    });
  });
});

describe("GPU info helpers", () => {
  it("shares one in-flight hardware query within an explicit detector", async () => {
    const detected = buildAppleGpuInfo("Apple M3 Pro", 36 * 1024 ** 3);
    const query = vi.fn().mockResolvedValue(detected);
    const detector = new GpuInfoDetector(query);

    await expect(
      Promise.all([detector.detect(), detector.detect()]),
    ).resolves.toEqual([detected, detected]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("parses NVIDIA RTX generations from common GPU names", () => {
    expect(parseRtxGeneration("NVIDIA GeForce RTX 4090")).toBe(40);
    expect(parseRtxGeneration("NVIDIA GeForce RTX 5070 Ti")).toBe(50);
    expect(parseRtxGeneration("NVIDIA RTX 3060 Laptop GPU")).toBe(30);
    expect(parseRtxGeneration("NVIDIA GeForce RTX 2080 Ti")).toBe(20);
    expect(parseRtxGeneration("NVIDIA GeForce GTX 1080 Ti")).toBeNull();
    expect(parseRtxGeneration(null)).toBeNull();
  });

  it("parses AMD Radeon GPU names and VRAM from Windows WMI output", () => {
    expect(
      parseWindowsAmdGpuLine("AMD Radeon RX 7900 XTX,25753026560"),
    ).toEqual({
      name: "AMD Radeon RX 7900 XTX",
      memoryMb: 24560,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: null,
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true,
    });
    expect(parseWindowsAmdGpuLine("AMD Radeon PRO V710,0")).toEqual({
      name: "AMD Radeon PRO V710",
      memoryMb: 28672,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: null,
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true,
    });
    const wmiSep = "\u001f";
    expect(
      parseWindowsAmdGpuLine(
        [
          "Microsoft Hyper-V Video",
          "Advanced Micro Devices, Inc.",
          "AMD Radeon PRO V710",
          "PCI\\VEN_1002&DEV_7461",
          "0",
        ].join(wmiSep),
      ),
    ).toEqual({
      name: "AMD Radeon PRO V710",
      memoryMb: 28672,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: null,
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true,
    });
    expect(
      parseWindowsAmdGpuLine(
        [
          "Microsoft Hyper-V Video",
          "Advanced Micro Devices, Inc.",
          "",
          "PCI\\VEN_1002&DEV_7461",
          "0",
        ].join(wmiSep),
      ),
    ).toEqual({
      name: "Advanced Micro Devices, Inc.",
      memoryMb: 28672,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: null,
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true,
    });
    expect(
      parseWindowsAmdGpuLine(
        [
          "AMD Radeon PRO V710 MxGPU",
          "Advanced Micro Devices, Inc.",
          "Display",
          "PCI\\VEN_1002&DEV_7460",
          "",
        ].join(wmiSep),
      ),
    ).toEqual({
      name: "AMD Radeon PRO V710 MxGPU",
      memoryMb: 28672,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: null,
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true,
    });
    expect(parseWindowsAmdGpuLine("AMD Radeon PRO W7900,0")).toEqual({
      name: "AMD Radeon PRO W7900",
      memoryMb: 49152,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: null,
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true,
    });
  });

  it("parses AMD ROCm SMI lines as ROCm-capable GPUs", () => {
    expect(
      parseRocmSmiGpuLine("card0, AMD Radeon RX 7900 XTX, 24 GiB, gfx1100"),
    ).toEqual({
      name: "AMD Radeon RX 7900 XTX",
      memoryMb: 24576,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: "gfx1100",
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true,
    });
  });

  it("maps AMD GPU names and gfx arch strings to Lemonade ROCm runtime targets", () => {
    expect(resolveAmdRocmTargetFromArch("gfx1200")).toBe("gfx120X");
    expect(resolveAmdRocmTargetFromArch("gfx1101")).toBe("gfx110X");
    expect(resolveAmdRocmTargetFromArch("gfx1034")).toBe("gfx103X");
    expect(inferAmdRocmTargetFromName("AMD Radeon RX 9070 XT")).toBe("gfx120X");
    expect(inferAmdRocmTargetFromName("AMD Radeon AI PRO R9700")).toBe(
      "gfx120X",
    );
    expect(inferAmdRocmTargetFromName("AMD Radeon PRO V710")).toBe("gfx110X");
    expect(inferAmdRocmTargetFromName("AMD Radeon PRO V710 MxGPU")).toBe(
      "gfx110X",
    );
    expect(inferAmdRocmTargetFromName("AMD Radeon PRO W7900")).toBe("gfx110X");
    expect(inferAmdRocmTargetFromName("AMD Radeon RX 7900 XTX")).toBe(
      "gfx110X",
    );
    expect(inferAmdRocmTargetFromName("AMD Radeon PRO W6800")).toBe("gfx103X");
    expect(inferAmdRocmTargetFromName("AMD Radeon RX 6800 XT")).toBe("gfx103X");
    expect(
      inferAmdRocmTargetFromName("AMD Ryzen AI Max+ 395 with Radeon 8060S"),
    ).toBe("gfx1151");
    expect(
      inferAmdRocmTargetFromName("AMD Ryzen AI 9 HX 370 with Radeon 890M"),
    ).toBe("gfx1150");
    expect(inferAmdRocmTargetFromName("AMD Radeon 890M")).toBe("gfx1150");
    expect(
      inferAmdRocmTargetFromName("AMD Ryzen AI 7 350 with Radeon 860M"),
    ).toBeNull();
  });
});
