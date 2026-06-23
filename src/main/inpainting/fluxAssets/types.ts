import type { FluxBackend } from "../../../shared/inpaintingSettingsTypes";

export type FluxAssetProgress = {
  progressText: string;
  detail?: string;
  progressMode?: "determinate" | "indeterminate" | "log-only";
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  installLogLine?: string;
};

export type RemoteFileMetadata = {
  url: string;
  bytes: number;
  downloadedAt: string;
};

export type WindowsNativeBuildEnv = {
  sdkVersion?: string;
  pathEntries: string[];
  includePaths: string[];
  libPaths: string[];
};

export type NvidiaRedistPackage = {
  relative_path: string;
  size?: number;
};

export type PythonCommand = {
  command: string;
  args: string[];
};

export type FluxPythonRuntime = PythonCommand & {
  mode: "venv" | "target";
  executable: string;
  env?: NodeJS.ProcessEnv;
  packageDir: string | null;
};

export type FluxPythonInstallBatch = {
  id: string;
  progressText: string;
  detail: string;
  installLogLine: string;
  pipArgs: string[];
};

export type FluxPythonRuntimeLayout = {
  runtimeName: string;
  runtimeDir: string;
  venvDir: string;
  venvPythonPath: string;
  packageDir: string;
  workerPath: string;
  markerPath: string;
  tempDir: string;
};

export type FluxPythonBackend = "python-rocm" | "python-cpu";

export type FluxRuntimeBackend = FluxBackend | FluxPythonBackend;
