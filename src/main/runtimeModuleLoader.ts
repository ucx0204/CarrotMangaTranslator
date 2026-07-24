import { join } from "node:path";
import { getAppPaths } from "./appPaths";

const APP_RUNTIME_MODULE_FILES = {
  apiKeyRetry: "transport/api-key-retry.cjs",
  logitBias: "simple-page-logit-bias.cjs",
  modelHttpErrors: "transport/model-http-errors.cjs",
  overlayTools: "overlay-parser.cjs",
  requestBuilders: "simple-page-request-builders.cjs",
  requestSummary: "simple-page-request-summary.cjs",
  responseText: "simple-page-response-text.cjs",
  simplePage: "simple-page-translate.cjs",
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
    resolveAppRuntimeModulePath(getAppPaths().runtimeDir, moduleId),
  );
}

export function loadRuntimeModuleFromDirectory(
  runtimeDir: string,
  moduleId: AppRuntimeModuleId,
): unknown {
  return loadRuntimeModuleAtPath(
    resolveAppRuntimeModulePath(runtimeDir, moduleId),
  );
}

export function loadRuntimeModuleAtPath(modulePath: string): unknown {
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
