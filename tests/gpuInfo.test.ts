import { describe, expect, it } from "vitest";
import { parseRtxGeneration } from "../src/main/gpuInfo";

describe("GPU info helpers", () => {
  it("parses NVIDIA RTX generations from common GPU names", () => {
    expect(parseRtxGeneration("NVIDIA GeForce RTX 4090")).toBe(40);
    expect(parseRtxGeneration("NVIDIA GeForce RTX 5070 Ti")).toBe(50);
    expect(parseRtxGeneration("NVIDIA RTX 3060 Laptop GPU")).toBe(30);
    expect(parseRtxGeneration("NVIDIA GeForce RTX 2080 Ti")).toBe(20);
    expect(parseRtxGeneration("NVIDIA GeForce GTX 1080 Ti")).toBeNull();
    expect(parseRtxGeneration(null)).toBeNull();
  });
});
