import { describe, expect, it } from "vitest";
import {
  inferAmdRocmTargetFromName,
  parseRocmSmiGpuLine,
  parseRtxGeneration,
  parseWindowsAmdGpuLine,
  resolveAmdRocmTargetFromArch
} from "../src/main/gpuInfo";

describe("GPU info helpers", () => {
  it("parses NVIDIA RTX generations from common GPU names", () => {
    expect(parseRtxGeneration("NVIDIA GeForce RTX 4090")).toBe(40);
    expect(parseRtxGeneration("NVIDIA GeForce RTX 5070 Ti")).toBe(50);
    expect(parseRtxGeneration("NVIDIA RTX 3060 Laptop GPU")).toBe(30);
    expect(parseRtxGeneration("NVIDIA GeForce RTX 2080 Ti")).toBe(20);
    expect(parseRtxGeneration("NVIDIA GeForce GTX 1080 Ti")).toBeNull();
    expect(parseRtxGeneration(null)).toBeNull();
  });

  it("parses AMD Radeon GPU names and VRAM from Windows WMI output", () => {
    expect(parseWindowsAmdGpuLine("AMD Radeon RX 7900 XTX,25753026560")).toEqual({
      name: "AMD Radeon RX 7900 XTX",
      memoryMb: 24560,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: null,
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true
    });
  });

  it("parses AMD ROCm SMI lines as ROCm-capable GPUs", () => {
    expect(parseRocmSmiGpuLine("card0, AMD Radeon RX 7900 XTX, 24 GiB, gfx1100")).toEqual({
      name: "AMD Radeon RX 7900 XTX",
      memoryMb: 24576,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: "gfx1100",
      rocmTarget: "gfx110X",
      supportsRocm: true,
      supportsVulkan: true
    });
  });

  it("maps AMD GPU names and gfx arch strings to Lemonade ROCm runtime targets", () => {
    expect(resolveAmdRocmTargetFromArch("gfx1200")).toBe("gfx120X");
    expect(resolveAmdRocmTargetFromArch("gfx1101")).toBe("gfx110X");
    expect(resolveAmdRocmTargetFromArch("gfx1034")).toBe("gfx103X");
    expect(inferAmdRocmTargetFromName("AMD Radeon RX 9070 XT")).toBe("gfx120X");
    expect(inferAmdRocmTargetFromName("AMD Radeon RX 7900 XTX")).toBe("gfx110X");
    expect(inferAmdRocmTargetFromName("AMD Radeon RX 6800 XT")).toBe("gfx103X");
    expect(inferAmdRocmTargetFromName("AMD Radeon 890M")).toBe("gfx1150");
  });
});
