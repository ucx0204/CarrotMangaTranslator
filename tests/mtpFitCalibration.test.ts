import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
} from "../src/shared/modelPresets";

const require = createRequire(import.meta.url);
const {
  createMtpCalibrationRequestBody,
  isLikelyMtpVramThrottle,
  probeMtpServerPerformance,
  resolveMtpStartupTimeoutMs,
  shouldCalibrateMtpFit,
} = require("../src/main/runtime/model/mtp-fit-calibration.cjs") as {
  shouldCalibrateMtpFit: (
    options: Record<string, unknown>,
    platform?: NodeJS.Platform,
  ) => boolean;
  createMtpCalibrationRequestBody: (options?: Record<string, unknown>) => {
    messages: Array<{ content: Array<{ type: string }> }>;
  };
  isLikelyMtpVramThrottle: (
    error: unknown,
    options: Record<string, unknown>,
    observedFreeMiB: number | null,
    platform?: NodeJS.Platform,
  ) => boolean;
  probeMtpServerPerformance: (
    baseUrl: string,
    options: Record<string, unknown>,
  ) => Promise<{
    healthy: boolean;
    predictedPerSecond: number | null;
    predictedTokens: number | null;
    timedOut: boolean;
  }>;
  resolveMtpStartupTimeoutMs: (
    options: Record<string, unknown>,
    defaultTimeoutMs: number,
    platform?: NodeJS.Platform,
  ) => number;
};

afterEach(() => vi.unstubAllGlobals());

describe("MTP fit calibration", () => {
  it("only calibrates built-in QAT MTP speed models on Windows CUDA", () => {
    const speed = {
      modelRepo: GEMMA_12B_QAT_MODEL_REPO,
      modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
      llamaRuntimeProfile: "cuda12",
      useDraft: true,
      draftSpecType: "draft-mtp",
      gpuLayers: "fit",
    };
    expect(shouldCalibrateMtpFit(speed, "win32")).toBe(true);
    expect(
      shouldCalibrateMtpFit(
        { ...speed, fitEnabled: false, gpuLayers: "all" },
        "win32",
      ),
    ).toBe(false);
    expect(
      shouldCalibrateMtpFit(
        { ...speed, llamaRuntimeProfile: "vulkan" },
        "win32",
      ),
    ).toBe(false);
    expect(shouldCalibrateMtpFit(speed, "darwin")).toBe(false);
    expect(
      shouldCalibrateMtpFit(
        {
          ...speed,
          modelRepo: GEMMA_12B_MODEL_REPO,
          modelFile: GEMMA_12B_MODEL_FILE_Q4_K_M,
        },
        "win32",
      ),
    ).toBe(false);
  });

  it("uses a text-only startup probe when the endpoint does not load vision", () => {
    const textOnly = createMtpCalibrationRequestBody({
      textOnlyModel: true,
    });
    const multimodal = createMtpCalibrationRequestBody();

    expect(textOnly.messages[0]?.content.map((part) => part.type)).toEqual([
      "text",
    ]);
    expect(multimodal.messages[0]?.content.map((part) => part.type)).toEqual([
      "image_url",
      "text",
    ]);
  });

  it("bounds only the risky Windows CUDA MTP startup and identifies low-VRAM timeouts", () => {
    const speed = {
      modelRepo: GEMMA_12B_QAT_MODEL_REPO,
      modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
      llamaRuntimeProfile: "cuda12",
      useDraft: true,
      draftSpecType: "draft-mtp",
      gpuLayers: "fit",
      fitTargetMb: 1536,
    };

    expect(resolveMtpStartupTimeoutMs(speed, 1_800_000, "win32")).toBe(60_000);
    expect(
      resolveMtpStartupTimeoutMs(
        { ...speed, useDraft: false },
        1_800_000,
        "win32",
      ),
    ).toBe(1_800_000);
    const timeout = new Error(
      "Timed out while waiting for llama-server at http://127.0.0.1:18180/v1",
    );
    expect(isLikelyMtpVramThrottle(timeout, speed, 1200, "win32")).toBe(true);
    expect(isLikelyMtpVramThrottle(timeout, speed, 1600, "win32")).toBe(false);
    expect(
      isLikelyMtpVramThrottle(
        new Error("model file missing"),
        speed,
        100,
        "win32",
      ),
    ).toBe(false);
  });

  it("probes the configured full context without changing the saved limits", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            timings: { predicted_n: 32, predicted_per_second: 54.5 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const result = await probeMtpServerPerformance(
      "http://127.0.0.1:18180/v1",
      {
        computeGpuIndex: null,
        textOnlyModel: true,
        ctx: 32_768,
        maxTokens: 32_768,
        fitTargetMb: 1536,
      },
    );

    expect(result).toMatchObject({
      healthy: true,
      predictedTokens: 32,
      predictedPerSecond: 54.5,
      timedOut: false,
    });
    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request.max_tokens).toBe(32);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
