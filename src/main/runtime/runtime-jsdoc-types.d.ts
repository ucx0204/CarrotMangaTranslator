export type CommandSpec = {
  executable: string;
  args: string[];
};

export type RuntimeOptions = {
  abortSignal?: AbortSignal | null;
  apiKey?: string | null;
  apiKeyMaxAttempts?: number | string | null;
  apiRetryDelaySeconds?: number | string | null;
  amdRocmTarget?: string | null;
  computeGpuIndex?: number | null;
  disableHostRocmTargetDetection?: boolean | null;
  hfEndpoint?: string | null;
  hfHomeDir?: string | null;
  hfHubCacheDir?: string | null;
  imagePath?: string | null;
  keepOcrBatchArtifacts?: boolean | null;
  llamaCacheDir?: string | null;
  llamaRocmTarget?: string | null;
  ocrBatchCompletedBefore?: number | string | null;
  ocrBatchTotal?: number | string | null;
  ocrBboxCommand?: string | null;
  ocrBboxMode?: string | null;
  ocrBboxProvider?: string | null;
  ocrCpuWorkerMinFreeRamPercent?: number | string | null;
  ocrCpuWorkerRamPollMs?: number | string | null;
  ocrCpuWorkers?: number | string | null;
  ocrCpuWorkerStartDelayMs?: number | string | null;
  ocrDevice?: string | null;
  ocrDetLimit?: string | number | null;
  ocrEngine?: string | null;
  ocrEngineDtype?: string | null;
  ocrGpuBackend?: string | null;
  ocrGpuCudaTag?: string | null;
  ocrMergeMode?: string | null;
  ocrPageIndex?: number | null;
  ocrPageTotal?: number | null;
  ocrProgressDefaultToPage?: boolean | null;
  ocrRecBatch?: string | number | null;
  ocrRuntimeDir?: string | null;
  ocrTextDetectionModelName?: string | null;
  ocrTextRecognitionModelName?: string | null;
  ocrVersion?: string | null;
  ocrWorkerThreads?: number | string | null;
  outputDir?: string | null;
  pageIndex?: number | null;
  pageTotal?: number | null;
  progressMode?: string | null;
  rocmArch?: string | null;
  rocmTarget?: string | null;
  serverLogPath?: string | null;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  toolsDir?: string | null;
  workingDir?: string | null;
};

export type OcrRuntimeLayout = {
  diagnostics?: unknown[];
  includePackageDir?: boolean;
  packageDir?: string;
  paddlexCacheHome?: string;
  prepared?: boolean;
  pythonPath?: string;
  realPaddlexCacheHome?: string;
  runtimeDir?: string;
  runtimeVariant?: string;
  usesTargetPackageDir?: boolean;
};

export type OcrRuntimeOptions = RuntimeOptions & {
  ocrRuntime?: OcrRuntimeLayout | null;
};

export type ChildEnvBuildOptions = {
  extraKeys?: string[];
  includeProcessPath?: boolean;
  pathDirs?: Array<string | null | undefined>;
};

export type ChildEnvironment = Record<string, string>;

export type LlamaRuntimeArchive = {
  archive: string;
  url: string;
  sha256?: string;
  expectedBytes?: number;
  type?: "zip" | "tar.gz";
  stripComponents?: number;
};

export type LlamaRuntimeDescriptor = {
  archive?: string;
  archives?: LlamaRuntimeArchive[];
  backend?: string;
  platform?: string;
  arch?: string;
  dflashRing?: "cpu" | "gpu";
  dir: string;
  id?: string;
  kind?: string;
  requiredFiles?: Array<string | string[]>;
  url?: string;
};

export type DetailedError = Error & {
  baseUrl?: string;
  range?: string;
  rangeEnd?: unknown;
  rangeFallbackFailed?: boolean;
  rangeInvalid?: boolean;
  retryAfterMs?: number;
  rangeStart?: unknown;
  rangeUnsupported?: boolean;
  optionSummary?: unknown;
  rawTextPreview?: unknown;
  requestSummary?: unknown;
  serverPath?: string;
  status?: unknown;
  statusText?: unknown;
  stallTimeoutMs?: unknown;
};

declare module "adm-zip" {
  type ZipEntry = {
    entryName: string;
    isDirectory: boolean;
    getData(): Buffer;
  };

  class AdmZip {
    constructor(archivePath?: string | Buffer);
    getEntries(): ZipEntry[];
    extractEntryTo(
      entry: string | ZipEntry,
      targetPath: string,
      maintainEntryPath?: boolean,
      overwrite?: boolean,
      keepOriginalPermission?: boolean,
      outFileName?: string,
    ): void;
  }

  export = AdmZip;
}
