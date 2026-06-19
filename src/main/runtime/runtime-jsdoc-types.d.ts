export type RuntimeOptions = {
  abortSignal?: AbortSignal | null;
  amdRocmTarget?: string | null;
  hfEndpoint?: string | null;
  hfHomeDir?: string | null;
  hfHubCacheDir?: string | null;
  imagePath?: string | null;
  keepOcrBatchArtifacts?: boolean | null;
  llamaCacheDir?: string | null;
  ocrBatchCompletedBefore?: number | string | null;
  ocrBatchTotal?: number | string | null;
  ocrBboxCommand?: string | null;
  ocrBboxProvider?: string | null;
  ocrDevice?: string | null;
  ocrGpuBackend?: string | null;
  ocrGpuCudaTag?: string | null;
  ocrPageIndex?: number | null;
  ocrPageTotal?: number | null;
  ocrProgressDefaultToPage?: boolean | null;
  ocrRuntimeDir?: string | null;
  outputDir?: string | null;
  pageIndex?: number | null;
  pageTotal?: number | null;
  progressMode?: string | null;
  serverLogPath?: string | null;
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

export type DetailedError = Error & {
  baseUrl?: string;
  range?: string;
  rangeEnd?: unknown;
  rangeFallbackFailed?: boolean;
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
