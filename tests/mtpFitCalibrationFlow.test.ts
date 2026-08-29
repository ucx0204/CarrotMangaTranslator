import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { calibrateMtpFitServer } =
  require("../src/main/runtime/transport/mtp-fit-calibration-flow.cjs") as {
    calibrateMtpFitServer: (
      baseUrl: string,
      options: Record<string, unknown>,
      dependencies: CalibrationDependencies,
    ) => Promise<void>;
  };

type Probe = {
  healthy: boolean;
  minimumFreeMiB: number | null;
  predictedPerSecond: number | null;
  timedOut?: boolean;
};

type CalibrationDependencies = {
  measureNvidiaFreeVramMiB: () => Promise<number | null>;
  probeMtpServerPerformance: () => Promise<Probe>;
  shouldCalibrateMtpFit: () => boolean;
};

function dependencies(probes: Probe[]): CalibrationDependencies {
  return {
    measureNvidiaFreeVramMiB: vi.fn().mockResolvedValue(900),
    probeMtpServerPerformance: vi
      .fn()
      .mockImplementation(async () => probes.shift() as Probe),
    shouldCalibrateMtpFit: vi.fn().mockReturnValue(true),
  };
}

describe("MTP fit calibration server flow", () => {
  it("keeps the configured free-VRAM target when the probe is healthy", async () => {
    const progress = vi.fn();
    const savedOptions = { fitTargetMb: 1024, onProgress: progress };
    const restart = vi.fn().mockResolvedValue(undefined);
    const calibration = dependencies([
      { healthy: true, minimumFreeMiB: 646, predictedPerSecond: 48.3 },
    ]);

    await calibrateMtpFitServer(
      "http://127.0.0.1:18180/v1",
      savedOptions,
      calibration,
    );

    expect(savedOptions.fitTargetMb).toBe(1024);
    expect(restart).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ progressText: "MTP VRAM 여유 측정 중" }),
    );
  });

  it("does nothing when calibration is disabled", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const calibration = dependencies([]);
    calibration.shouldCalibrateMtpFit = vi.fn().mockReturnValue(false);

    await calibrateMtpFitServer(
      "http://127.0.0.1:18180/v1",
      { fitTargetMb: 1153 },
      calibration,
    );

    expect(restart).not.toHaveBeenCalled();
    expect(calibration.probeMtpServerPerformance).not.toHaveBeenCalled();
  });

  it("stops immediately with an error toast when the probe times out", async () => {
    const progress = vi.fn();
    const restart = vi.fn().mockResolvedValue(undefined);
    const calibration = dependencies([
      {
        healthy: false,
        minimumFreeMiB: 900,
        predictedPerSecond: null,
        timedOut: true,
      },
      { healthy: true, minimumFreeMiB: 1200, predictedPerSecond: 20 },
    ]);

    await expect(
      calibrateMtpFitServer(
        "http://127.0.0.1:18180/v1",
        { fitTargetMb: 1024, onProgress: progress },
        calibration,
      ),
    ).rejects.toMatchObject({
      message:
        "Gemma가 VRAM 부족으로 너무 느려 작업을 중단했습니다. 설정에서 컨텍스트 길이와 최대 출력 토큰을 낮춰 주세요.",
      probeTimedOut: true,
    });

    expect(restart).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: {
          variant: "error",
          message: expect.stringContaining(
            "컨텍스트 길이와 최대 출력 토큰을 낮춰 주세요",
          ),
        },
      }),
    );
  });

  it("does not keep restarting when decode speed is already unhealthy", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const calibration = dependencies(
      Array.from({ length: 7 }, (_value, index) => ({
        healthy: false,
        minimumFreeMiB: 1200,
        predictedPerSecond: 2 + index,
      })),
    );

    await expect(
      calibrateMtpFitServer(
        "http://127.0.0.1:18180/v1",
        { fitTargetMb: 1024 },
        calibration,
      ),
    ).rejects.toMatchObject({
      message:
        "Gemma가 VRAM 부족으로 너무 느려 작업을 중단했습니다. 설정에서 컨텍스트 길이와 최대 출력 토큰을 낮춰 주세요.",
      effectiveFitTargetMiB: 1024,
      predictedTokensPerSecond: 2,
    });
    expect(restart).not.toHaveBeenCalled();
  });
});
