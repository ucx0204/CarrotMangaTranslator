import type { KoharuInpaintingBackend } from "../../shared/inpaintingSettingsTypes";

export type KoharuWorkerRequest = {
  input: string;
  mask: string;
  bubbleMask: string;
  output: string;
  windows: Array<[number, number, number, number]>;
  maxPixels?: number;
};

export type KoharuWorkerLaunchSpec = {
  backend: KoharuInpaintingBackend;
  computeGpuIndex?: number;
  executable: string;
  args: string[];
  runtimePath: string;
  label: string;
  env?: NodeJS.ProcessEnv;
};
