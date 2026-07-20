import { afterEach, describe, expect, it } from "vitest";
import {
  resolveAvailableBubbleQualityModel,
  resolveBubbleQualityTorchDevice,
} from "../src/main/inpainting/bubbleQualityRuntime";

const originalToken = process.env.HF_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = originalToken;
});

describe("bubble highest-quality runtime policy", () => {
  it("uses SAM 2.1 for the normal highest-quality mode on every backend", () => {
    expect(resolveAvailableBubbleQualityModel("sam2.1", "cuda-native")).toBe(
      "sam2.1",
    );
    expect(resolveAvailableBubbleQualityModel("sam2.1", "metal-native")).toBe(
      "sam2.1",
    );
  });

  it("allows experimental SAM 3 only with NVIDIA and an explicit token", () => {
    process.env.HF_TOKEN = "approved-token";
    expect(resolveAvailableBubbleQualityModel("sam3", "cuda-native")).toBe(
      "sam3",
    );
    expect(resolveAvailableBubbleQualityModel("sam3", "metal-native")).toBe(
      "sam2.1",
    );

    delete process.env.HF_TOKEN;
    expect(resolveAvailableBubbleQualityModel("sam3", "cuda-native")).toBe(
      "sam2.1",
    );
  });

  it("maps native backends to safe PyTorch devices", () => {
    expect(resolveBubbleQualityTorchDevice("cuda-native")).toBe("cuda");
    expect(resolveBubbleQualityTorchDevice("metal-native")).toBe("mps");
    expect(resolveBubbleQualityTorchDevice("zluda-native")).toBe("cpu");
    expect(resolveBubbleQualityTorchDevice("cpu")).toBe("cpu");
  });
});
