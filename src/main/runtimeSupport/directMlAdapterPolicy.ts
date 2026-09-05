import type { HardwareGpuSettings } from "../../shared/gpuSettings";

export type DirectMlDeviceRequest = HardwareGpuSettings & {
  /** Ordinals are only mapped when the worker uses CUDA's device namespace. */
  computeGpuBackend?: string;
};

export type DirectMlAdapter = {
  deviceId: number;
  name: string;
  luid: string;
  highPerformanceRank: number;
  dedicatedVideoMemory: number;
};

export function selectDirectMlAdapter(
  request: DirectMlDeviceRequest,
  adapters: readonly DirectMlAdapter[],
  cudaLuid?: string,
): DirectMlAdapter {
  if (
    request.computeGpuIndex !== undefined &&
    request.computeGpuBackend === "cuda"
  ) {
    const matches = adapters.filter((adapter) => adapter.luid === cudaLuid);
    if (matches.length !== 1) {
      throw new Error(
        "선택한 CUDA GPU를 DirectML 어댑터 LUID에 연결할 수 없습니다.",
      );
    }
    return matches[0];
  }
  const ranked = [...adapters].sort((left, right) =>
    request.graphicsGpuPreference === "high-performance"
      ? left.highPerformanceRank - right.highPerformanceRank
      : left.deviceId - right.deviceId,
  );
  if (!ranked[0])
    throw new Error("DirectML을 지원하는 Windows GPU가 없습니다.");
  return ranked[0];
}
