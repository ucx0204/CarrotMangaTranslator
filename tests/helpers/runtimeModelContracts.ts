import { afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GEMMA_DRAFT_MODEL_FILE,
  DEFAULT_GEMMA_DRAFT_MODEL_REPO,
  DEFAULT_GEMMA_MMPROJ_FILE,
  DEFAULT_GEMMA_MMPROJ_REPO,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
  GEMMA_12B_MMPROJ_FILE,
  GEMMA_12B_MMPROJ_REPO,
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_26B_MMPROJ_FILE,
  GEMMA_26B_MMPROJ_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
} from "../../src/shared/modelPresets";

const runtimeHelpers = {
  ...require("../../src/main/runtime/simple-page-launch-args.cjs"),
  ...require("../../src/main/runtime/simple-page-request-builders.cjs"),
  ...require("../../src/main/runtime/simple-page-ocr-runtime-config.cjs"),
  ...require("../../src/main/runtime/simple-page-ocr-commands.cjs"),
  ...require("../../src/main/runtime/simple-page-ocr-model-assets.cjs"),
  ...require("../../src/main/runtime/simple-page-image-variants.cjs"),
  ...require("../../src/main/runtime/simple-page-model-assets.cjs"),
  ...require("../../src/main/runtime/simple-page-ocr-runtime-manager.cjs"),
  ...require("../../src/main/runtime/simple-page-ocr-bbox-pipeline.cjs"),
  ...require("../../src/main/runtime/simple-page-prompts.cjs"),
  ...require("../../src/main/runtime/simple-page-response-text.cjs"),
  ...require("../../src/main/runtime/simple-page-progress.cjs"),
  ...require("../../src/main/runtime/simple-page-runtime-paths.cjs"),
  ...require("../../src/main/runtime/simple-page-cache-paths.cjs"),
  ...require("../../src/main/runtime/simple-page-server-lifecycle.cjs"),
  ...require("../../src/main/runtime/simple-page-translation-requests.cjs"),
} as {
  buildOcrPipBuildToolUpgradeCommand: (
    pythonPath: string,
    pipProgressArgs?: string,
  ) => string;
  buildOcrPipInstallCommand: (
    pythonPath: string,
    packages: string[],
    targetDir: string | null,
    options?: { [key: string]: unknown },
    pipProgressArgs?: string,
  ) => string;
  buildLaunchArgs: (options: { [key: string]: unknown }) => string[];
  buildMessages: (
    options: { [key: string]: unknown },
    imageVariants: Array<{
      role: string;
      dataUrl: string;
      width?: number;
      height?: number;
      originalWidth?: number;
      originalHeight?: number;
    }>,
  ) => Array<{
    role: string;
    content: Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
  }>;
  buildResponsesRequestBody: (
    options: { [key: string]: unknown },
    imageVariants: Array<{
      role: string;
      dataUrl: string;
      width?: number;
      height?: number;
      originalWidth?: number;
      originalHeight?: number;
    }>,
  ) => {
    model: string;
    instructions: string;
    input: Array<{
      role: string;
      content: Array<{
        type: string;
        text?: string;
        image_url?: string;
        detail?: string;
      }>;
    }>;
    reasoning: { effort: string };
    stream: boolean;
    store: boolean;
  };
  buildOcrRuntimeEnv: (
    options: { [key: string]: unknown },
    runtime?: {
      runtimeDir?: string;
      packageDir?: string;
      includePackageDir?: boolean;
    },
  ) => Record<string, string>;
  buildLlamaServerEnv: (
    serverPath: string,
    options: { [key: string]: unknown },
  ) => Record<string, string>;
  buildPaddleOcrImportCheckScript: (options?: {
    [key: string]: unknown;
  }) => string;
  buildOcrBboxCommand: (
    options: { [key: string]: unknown },
    provider: string,
    outputPath: string,
    runtime?: { pythonPath?: string } | null,
  ) => string;
  buildOcrBboxBatchCommand: (
    options: { [key: string]: unknown },
    batchPath: string,
    runtime?: { pythonPath?: string } | null,
    progressPath?: string | null,
  ) => string;
  buildPaddleOcrImportFailureMessage: (
    message: string,
    options?: { [key: string]: unknown },
  ) => string;
  getOverlayPrompt: (
    options: { [key: string]: unknown },
    imageVariants: Array<{
      role: string;
      dataUrl?: string;
      width?: number;
      height?: number;
      originalWidth?: number;
      originalHeight?: number;
    }>,
  ) => string;
  collectOcrBboxHints: (options: { [key: string]: unknown }) => Promise<{
    hints: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      ocrText?: string;
      groupId?: string;
      rolePrior?: string;
      orderInGroup?: number;
    }>;
    diagnostics: unknown[];
    noTextDetected: boolean;
    textEvidenceCount: number;
  }>;
  collectRequiredHfDownloads: (options: {
    [key: string]: unknown;
  }) => Array<{ kind: string; file: string; destination: string }>;
  collectRequiredPaddleOcrModelDownloads: (
    options: { [key: string]: unknown },
    runtime?: { runtimeDir?: string },
  ) => Array<{
    kind: string;
    repo: string;
    file: string;
    destination: string;
    url: string;
  }>;
  extractModelOutputText: (parsed: unknown) => string;
  inspectModelLaunch: (options: { [key: string]: unknown }) => {
    launchMode: string;
    model?: string;
    reasoningEffort?: string;
  };
  isModelCached: (options: { [key: string]: unknown }) => boolean;
  parseOcrBatchProgressLine: (
    line: string,
  ) => { index: number; total: number; count: number } | null;
  parsePaddleModelFetchProgress: (line: string) => {
    totalFiles: number;
    currentFiles: number | null;
    percent: number | null;
  } | null;
  parsePipRawProgress: (
    line: string,
  ) => { current: number; total: number } | null;
  parseResponsesSseText: (rawText: string) => {
    outputText: string;
    eventCount: number;
    rawResponse: unknown;
  };
  requestTranslation: (
    server: { baseUrl: string },
    options: { [key: string]: unknown },
  ) => Promise<{
    outputText: string;
    rawResponse: unknown;
    requestBody: Record<string, unknown>;
  }>;
  resolveOcrGpuBackend: (options?: { [key: string]: unknown }) => string;
  resolveOcrGpuCudaTag: (options?: { [key: string]: unknown }) => string;
  resolveOcrGpuPackageIndexUrl: (options?: {
    [key: string]: unknown;
  }) => string;
  resolveOcrInstallBatchLabel: (
    packages: string[],
    options?: { [key: string]: unknown },
  ) => string;
  isWindowsRocmOcrRuntimePathShortEnough: (runtimeDir: string) => boolean;
  resolveOcrPipInstallBatches: (options?: {
    [key: string]: unknown;
  }) => string[][];
  resolveOcrPipCacheDir: (
    runtimeDir: string,
    options?: { [key: string]: unknown },
  ) => string;
  resolveOcrPipInstallExtraArgs: (
    packages: string[],
    options?: { [key: string]: unknown },
  ) => string[];
  resolveOcrPythonPackageDir: (
    runtimeDir: string,
    options?: { [key: string]: unknown },
  ) => string;
  resolveOcrPythonUserBaseDir: (
    runtimeDir: string,
    options?: { [key: string]: unknown },
  ) => string;
  resolveOcrRuntimeDir: (options?: { [key: string]: unknown }) => string;
  resolveOcrRuntimeVariant: (options?: { [key: string]: unknown }) => string;
  resolveOcrTempDir: (
    runtimeDir: string,
    options?: { [key: string]: unknown },
  ) => string;
  resolveOcrVenvDir: (
    runtimeDir: string,
    runtimeVariant: string,
    options?: { [key: string]: unknown },
  ) => string;
  resolvePaddleOcrImportCheckTimeoutMs: (options?: {
    [key: string]: unknown;
  }) => number;
  resolveFfmpegPath: (options: { [key: string]: unknown }) => string;
  resolveLlamaCppCacheDir: (options?: {
    [key: string]: unknown;
  }) => string | null;
  resolveOcrBboxTimeoutMs: (pageCount?: number) => number;
  resolveOcrInstallBatchProgressRanges: (
    batches: string[][],
    start: number,
    end: number,
  ) => Array<{ start: number; end: number }>;
  resolveManagedHfFilePath: (
    options: { [key: string]: unknown },
    repo: string,
    file: string,
  ) => string | null;
  summarizeOcrInstallBatches: (
    batches: string[][],
    options?: { [key: string]: unknown },
  ) => string;
};
export const runtimeDefaults =
  require("../../src/main/runtime/simple-page-defaults.cjs") as {
    DEFAULT_MODEL_HF: string;
    DEFAULT_HF_FILE: string;
    DEFAULT_MMPROJ_HF: string;
    DEFAULT_MMPROJ_FILE: string;
  };
const llamaRuntimeResolver =
  require("../../src/main/runtime/resolve-llama-runtime.cjs") as {
    bundledServerCandidates: (toolsDir: string) => string[];
    resolveBundledServerPath: (toolsDir: string) => string;
  };
const llamaRuntimeContracts =
  require("../../src/main/runtime/simple-page-llama-runtimes.cjs") as {
    BEELLAMA_LLAMA_RUNTIME_CUDA13: {
      id: string;
      requiredFiles: Array<string | string[]>;
    };
    LLAMA_RUNTIME_FILES: Set<string>;
    MAINLINE_LLAMA_RUNTIME_CUDA13: {
      id: string;
      requiredFiles: Array<string | string[]>;
    };
    shouldExtractLlamaRuntimeFile: (
      fileName: string,
      relativePath?: string,
    ) => boolean;
  };
export const {
  buildOcrPipBuildToolUpgradeCommand,
  buildOcrPipInstallCommand,
  buildLaunchArgs,
  buildMessages,
  buildOcrRuntimeEnv,
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand,
  buildLlamaServerEnv,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  buildResponsesRequestBody,
  collectOcrBboxHints,
  collectRequiredHfDownloads,
  collectRequiredPaddleOcrModelDownloads,
  getOverlayPrompt,
  extractModelOutputText,
  inspectModelLaunch,
  isModelCached,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  parsePipRawProgress,
  resolveOcrInstallBatchProgressRanges,
  resolveManagedHfFilePath,
  resolveOcrBboxTimeoutMs,
  resolveFfmpegPath,
  resolveLlamaCppCacheDir,
  parseResponsesSseText,
  requestTranslation,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrInstallBatchLabel,
  isWindowsRocmOcrRuntimePathShortEnough,
  resolveOcrPipInstallBatches,
  resolveOcrPipCacheDir,
  resolveOcrPipInstallExtraArgs,
  resolveOcrPythonPackageDir,
  resolveOcrPythonUserBaseDir,
  resolveOcrRuntimeDir,
  resolveOcrRuntimeVariant,
  resolveOcrTempDir,
  resolveOcrVenvDir,
  resolvePaddleOcrImportCheckTimeoutMs,
  summarizeOcrInstallBatches,
} = runtimeHelpers;
export const { bundledServerCandidates, resolveBundledServerPath } =
  llamaRuntimeResolver;
export const {
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  LLAMA_RUNTIME_FILES,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  shouldExtractLlamaRuntimeFile,
} = llamaRuntimeContracts;

const tempDirs: string[] = [];
export const DEFAULT_31B_REPO = DEFAULT_GEMMA_MODEL_REPO;
export const DEFAULT_31B_FILE = DEFAULT_GEMMA_MODEL_FILE;
export const DEFAULT_MMPROJ_REPO = DEFAULT_GEMMA_MMPROJ_REPO;
export const DEFAULT_MMPROJ_FILE = DEFAULT_GEMMA_MMPROJ_FILE;
export const DEFAULT_DRAFT_REPO = DEFAULT_GEMMA_DRAFT_MODEL_REPO;
export const DEFAULT_DRAFT_FILE = DEFAULT_GEMMA_DRAFT_MODEL_FILE;
export const DEFAULT_12B_REPO = GEMMA_12B_MODEL_REPO;
export const DEFAULT_12B_FILE = GEMMA_12B_MODEL_FILE_Q4_K_M;
export const DEFAULT_12B_MMPROJ_REPO = GEMMA_12B_MMPROJ_REPO;
export const DEFAULT_12B_MMPROJ_FILE = GEMMA_12B_MMPROJ_FILE;
export const DEFAULT_26B_REPO = GEMMA_26B_MODEL_REPO;
export const DEFAULT_26B_FILE = GEMMA_26B_MODEL_FILE_IQ3_S;
export const DEFAULT_26B_MMPROJ_REPO = GEMMA_26B_MMPROJ_REPO;
export const DEFAULT_26B_MMPROJ_FILE = GEMMA_26B_MMPROJ_FILE;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export function writeCachedAssets({
  hubCacheDir,
  repoId,
  snapshot,
  modelFile,
  includeMmproj = true,
}: {
  hubCacheDir: string;
  repoId: string;
  snapshot: string;
  modelFile: string;
  includeMmproj?: boolean;
}): string {
  const snapshotDir = join(
    hubCacheDir,
    `models--${repoId.replace(/\//g, "--")}`,
    "snapshots",
    snapshot,
  );
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, modelFile), "model");
  if (includeMmproj) {
    writeFileSync(join(snapshotDir, "mmproj-BF16.gguf"), "mmproj");
  }
  return snapshotDir;
}

type OcrBatchPipelineModule = {
  collectOcrBboxHintsBatch: (
    pageOptionsList: Array<Record<string, unknown>>,
  ) => Promise<
    Array<{
      hints: unknown[];
      diagnostics: unknown[];
      noTextDetected: boolean;
      textEvidenceCount: number;
    }>
  >;
};

type ModuleCacheEntry = NodeJS.Module | undefined;

function setModuleExports(modulePath: string, exports: unknown): void {
  const original = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    path: original?.path ?? "",
    exports,
    filename: modulePath,
    loaded: true,
    children: [],
    paths: original?.paths ?? [],
    parent: original?.parent ?? null,
    isPreloading: false,
    require: original?.require ?? require,
  } as NodeJS.Module;
}

export async function withOcrBatchPipelineStubs<T>(
  stubs: {
    ensurePaddleOcrRuntime: (options: Record<string, unknown>) => unknown;
    runShellCommand: (
      command: string,
      options: { onOutput?: (line: string) => void },
    ) => Promise<{ stdout: string; stderr: string }>;
    buildOcrBboxBatchCommand: (
      options: Record<string, unknown>,
      batchPath: string,
    ) => string;
  },
  run: (pipeline: OcrBatchPipelineModule) => Promise<T>,
): Promise<T> {
  const pipelinePath =
    require.resolve("../../src/main/runtime/simple-page-ocr-bbox-pipeline.cjs");
  const runtimeManagerPath =
    require.resolve("../../src/main/runtime/simple-page-ocr-runtime-manager.cjs");
  const shellUtilsPath =
    require.resolve("../../src/main/runtime/simple-page-shell-utils.cjs");
  const commandsPath =
    require.resolve("../../src/main/runtime/simple-page-ocr-commands.cjs");
  const affectedPaths = [
    pipelinePath,
    runtimeManagerPath,
    shellUtilsPath,
    commandsPath,
  ];
  const originalEntries = new Map<string, ModuleCacheEntry>(
    affectedPaths.map((modulePath) => [modulePath, require.cache[modulePath]]),
  );
  const actualRuntimeManager = require(runtimeManagerPath) as Record<
    string,
    unknown
  >;
  const actualShellUtils = require(shellUtilsPath) as Record<string, unknown>;
  const actualCommands = require(commandsPath) as Record<string, unknown>;

  try {
    delete require.cache[pipelinePath];
    setModuleExports(runtimeManagerPath, {
      ...actualRuntimeManager,
      ensurePaddleOcrRuntime: stubs.ensurePaddleOcrRuntime,
    });
    setModuleExports(shellUtilsPath, {
      ...actualShellUtils,
      runShellCommand: stubs.runShellCommand,
    });
    setModuleExports(commandsPath, {
      ...actualCommands,
      buildOcrBboxBatchCommand: stubs.buildOcrBboxBatchCommand,
    });

    const pipeline = require(pipelinePath) as OcrBatchPipelineModule;
    return await run(pipeline);
  } finally {
    for (const [modulePath, entry] of originalEntries) {
      if (entry) {
        require.cache[modulePath] = entry;
      } else {
        delete require.cache[modulePath];
      }
    }
  }
}
