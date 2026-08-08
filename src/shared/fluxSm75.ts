import type { FluxBackend } from "./inpaintingSettingsTypes";

const FLUX_SM75_COMPUTE_CAPABILITY = 7.5;
const FLUX_SM75_RTX_GENERATION = 20;

export function isFluxSm75ComputeCapability(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.round(value * 10) === FLUX_SM75_COMPUTE_CAPABILITY * 10
  );
}

export function isFluxRtx20Sm75Hardware(options: {
  computeCapability: unknown;
  rtxGeneration: unknown;
}): boolean {
  return (
    options.rtxGeneration === FLUX_SM75_RTX_GENERATION &&
    isFluxSm75ComputeCapability(options.computeCapability)
  );
}

export function shouldEnableExperimentalSm75Flux(options: {
  backend: FluxBackend;
  computeCapability: number | null | undefined;
}): boolean {
  return (
    options.backend === "cuda-sm75-experimental" &&
    isFluxSm75ComputeCapability(options.computeCapability)
  );
}
