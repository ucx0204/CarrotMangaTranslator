export type IllustratedTitleHint =
  | boolean
  | "masthead"
  | "lettering"
  | "caption"
  | "brush"
  | "solid-impact"
  | "upright-jacket"
  | "ruled-sound-shadow"
  | "balloon-edge-reading"
  | "duotone-overlay"
  | "isolated-title-stock"
  | `pigment:${string}`
  | `layered-title:${string}`
  | `washed-title:${string}`
  | `sound:${string}`
  | `edition:${string}`
  | `masthead:${string}`
  | `cover-columns:${string}`
  | `jacket:${string}`
  | `jacket-promo:${string}`
  | `jacket-strap:${string}`
  | `cover-title:${string}`;

export type FluxWorkerRequest = {
  input: string;
  mask: string;
  output: string;
  steps: number;
  strength: number;
  maxPixels: number;
  maskPadding: number;
  speechBubble?: boolean;
  illustratedTitle?: IllustratedTitleHint;
};

/** A native paper repair already contains the final source-resolution pixels. */
export type FluxWorkerCropResult = "native-paper" | void;

export type FluxWorkerBackend =
  | "cuda-native"
  | "rocm-native"
  | "vulkan-native"
  | "zluda-native"
  | "metal-native"
  | "cpu-native"
  | "python-rocm"
  | "python-cpu";

export type FluxCudaDevice = Readonly<{
  uuid: string;
  name: string | null;
  computeCapability: number;
}>;

export type FluxWorkerLaunchSpec = {
  backend: FluxWorkerBackend;
  computeGpuIndex?: number;
  cudaDevice?: FluxCudaDevice;
  executable: string;
  args: string[];
  runtimePath: string;
  label: string;
  env?: NodeJS.ProcessEnv;
};
