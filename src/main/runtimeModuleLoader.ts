import { join } from "node:path";

const APP_RUNTIME_MODULE_FILES = {
  nativeFfi: "koffi.node",
  llamaDownload: "model/llama-runtime-download.cjs",
  mainlineRuntimes: "model/speed-llama-runtime-contracts.cjs",
  processTermination: "transport/process-termination.cjs",
  imageSourceAssets: "assets/image-source-assets.cjs",
  ocrEnvironment: "ocr/runtime-environment.cjs",
  ocrCommands: "simple-page-ocr-commands.cjs",
  ocrProgress: "simple-page-progress.cjs",
  ocrProgressHandlers: "simple-page-ocr-progress-handlers.cjs",
  shellCommand: "transport/shell-command.cjs",
  ocrBatch: "simple-page-ocr-bbox-pipeline.cjs",
  animeTextRelations: "semantic-ocr/anime-text-review-relations.cjs",
  apiKeyRetry: "transport/api-key-retry.cjs",
  workContextPrompt: "prompts/work-context.cjs",
  downloadUtils: "simple-page-download-utils.cjs",
  directoryPublisher: "runtime-directory-publish.cjs",
  logitBias: "simple-page-logit-bias.cjs",
  modelHttpErrors: "transport/model-http-errors.cjs",
  overlayTools: "overlay-parser.cjs",
  requestBuilders: "simple-page-request-builders.cjs",
  requestSummary: "simple-page-request-summary.cjs",
  responseText: "simple-page-response-text.cjs",
  runtimePaths: "simple-page-runtime-paths.cjs",
  simplePage: "simple-page-translate.cjs",
  zipExtractor: "simple-page-zip-utils.cjs",
  tarExtractor: "simple-page-tar-utils.cjs",
} as const;

export type AppRuntimeModuleId = keyof typeof APP_RUNTIME_MODULE_FILES;

export function resolveAppRuntimeModulePath(
  runtimeDir: string,
  moduleId: AppRuntimeModuleId,
): string {
  return join(runtimeDir, APP_RUNTIME_MODULE_FILES[moduleId]);
}

export function loadAppRuntimeModule(moduleId: AppRuntimeModuleId): unknown {
  return loadRuntimeModuleAtPath(
    resolveAppRuntimeModulePath(resolveAppRuntimeDirectory(), moduleId),
  );
}

function resolveAppRuntimeDirectory(): string {
  return selectAppRuntimeDirectory({
    isVitest: Boolean(process.env.VITEST),
    resourcesPath: process.resourcesPath,
    testRuntimeDir: join(__dirname, "runtime"),
    resolveInstalledRuntimeDir: () => {
      // Explicit-directory consumers (Node workers) must not initialize Electron app paths.
      return (
        require("./appPaths") as {
          getAppPaths(): { runtimeDir: string };
        }
      ).getAppPaths().runtimeDir;
    },
  });
}

export function selectAppRuntimeDirectory(options: {
  isVitest: boolean;
  resourcesPath: string | undefined;
  testRuntimeDir: string;
  resolveInstalledRuntimeDir: () => string;
}): string {
  if (options.isVitest && typeof options.resourcesPath !== "string") {
    return options.testRuntimeDir;
  }
  return options.resolveInstalledRuntimeDir();
}

export function loadRuntimeModuleFromDirectory(
  runtimeDir: string,
  moduleId: AppRuntimeModuleId,
): unknown {
  return loadRuntimeModuleAtPath(
    resolveAppRuntimeModulePath(runtimeDir, moduleId),
  );
}

function loadRuntimeModuleAtPath(modulePath: string): unknown {
  const loaded: unknown = require(modulePath);
  return loaded;
}

function isRuntimeModuleRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRuntimeFunctions(
  value: unknown,
  moduleLabel: string,
  functionNames: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRuntimeModuleRecord(value)) {
    throw new Error(`런타임 모듈이 올바르지 않습니다: ${moduleLabel} exports`);
  }
  for (const functionName of functionNames) {
    if (typeof value[functionName] !== "function") {
      throw new Error(
        `런타임 모듈이 올바르지 않습니다: ${moduleLabel} ${functionName}`,
      );
    }
  }
}
