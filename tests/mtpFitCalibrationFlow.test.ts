import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { calibrateMtpFitServer } =
  require("../src/main/runtime/transport/mtp-fit-calibration-flow.cjs") as {
    calibrateMtpFitServer: (
      baseUrl: string,
      options: Record<string, unknown>,
      restart: (options: Record<string, unknown>) => Promise<void>,
      dependencies: CalibrationDependencies,
    ) => Promise<void>;
  };

type Probe = {
  healthy: boolean;
  minimumFreeMiB: number | null;
  predictedPerSecond: number | null;
};

type CalibrationDependencies = {
  calculateMtpFitCorrection: (input: {
    requestedFitTargetMiB: number;
    observedFreeMiB: number;
  }) => {
    requestedFitTargetMiB: number;
    observedFreeMiB: number;
    effectiveFitTargetMiB: number;
    correctionMiB: number;
  };
  measureNvidiaFreeVramMiB: () => Promise<number | null>;
  probeMtpServerPerformance: () => Promise<Probe>;
  shouldCalibrateMtpFit: () => boolean;
};

function correction({
  requestedFitTargetMiB,
  observedFreeMiB,
}: {
  requestedFitTargetMiB: number;
  observedFreeMiB: number;
}) {
  const correctionMiB = observedFreeMiB < requestedFitTargetMiB ? 512 : 0;
  return {
    requestedFitTargetMiB,
    observedFreeMiB,
    effectiveFitTargetMiB: requestedFitTargetMiB + correctionMiB,
    correctionMiB,
  };
}

function dependencies(probes: Probe[]): CalibrationDependencies {
  return {
    calculateMtpFitCorrection: correction,
    measureNvidiaFreeVramMiB: vi.fn().mockResolvedValue(900),
    probeMtpServerPerformance: vi
      .fn()
      .mockImplementation(async () => probes.shift() as Probe),
    shouldCalibrateMtpFit: vi.fn().mockReturnValue(true),
  };
}

describe("MTP fit calibration server flow", () => {
  it("restarts once with a runtime-only correction and reports it", async () => {
    const progress = vi.fn();
    const savedOptions = { fitTargetMb: 1024, onProgress: progress };
    const restart = vi.fn().mockResolvedValue(undefined);
    const calibration = dependencies([
      { healthy: true, minimumFreeMiB: 646, predictedPerSecond: 48.3 },
      { healthy: true, minimumFreeMiB: 688, predictedPerSecond: 51.2 },
    ]);

    await calibrateMtpFitServer(
      "http://127.0.0.1:18180/v1",
      savedOptions,
      restart,
      calibration,
    );

    expect(savedOptions.fitTargetMb).toBe(1024);
    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({ fitTargetMb: 1536 }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({
          message: expect.stringContaining("1024 → 1536 MiB"),
        }),
      }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        progressText: "MTP VRAM 보정 확인 완료",
        detail: expect.stringContaining("51.2 tok/s"),
      }),
    );
  });

  it("does nothing when calibration is disabled", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const calibration = dependencies([]);
    calibration.shouldCalibrateMtpFit = vi.fn().mockReturnValue(false);

    await calibrateMtpFitServer(
      "http://127.0.0.1:18180/v1",
      { fitTargetMb: 1153 },
      restart,
      calibration,
    );

    expect(restart).not.toHaveBeenCalled();
    expect(calibration.probeMtpServerPerformance).not.toHaveBeenCalled();
  });

  it("fails after the one allowed restart remains unhealthy", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const calibration = dependencies([
      { healthy: false, minimumFreeMiB: 1200, predictedPerSecond: 2 },
      { healthy: false, minimumFreeMiB: 1200, predictedPerSecond: 3 },
    ]);

    await expect(
      calibrateMtpFitServer(
        "http://127.0.0.1:18180/v1",
        { fitTargetMb: 1024 },
        restart,
        calibration,
      ),
    ).rejects.toMatchObject({
      message: "MTP 서버가 VRAM 보정 후에도 비정상적으로 느립니다.",
      effectiveFitTargetMiB: 1536,
      predictedTokensPerSecond: 3,
    });
    expect(restart).toHaveBeenCalledOnce();
  });
});
