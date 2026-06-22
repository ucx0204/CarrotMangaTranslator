export type FluxWorkerRequest = {
  input: string;
  mask: string;
  output: string;
  steps: number;
  strength: number;
  maxPixels: number;
  maskPadding: number;
};

export type FluxWorkerBackend =
  | "cuda-native"
  | "zluda-native"
  | "python-rocm"
  | "python-cpu";

export type FluxWorkerLaunchSpec = {
  backend: FluxWorkerBackend;
  executable: string;
  args: string[];
  runtimePath: string;
  label: string;
  env?: NodeJS.ProcessEnv;
};
