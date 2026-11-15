export type FluxWorkerRequest = {
  input: string;
  mask: string;
  output: string;
  steps: number;
  strength: number;
  maxPixels: number;
  maskPadding: number;
  speechBubble?: boolean;
};

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
