import { resolve } from "node:path";
import type { ModelTestResult } from "../shared/jobTypes";
import type { OpenAICompatibleApiEndpoint } from "./openaiApiEndpoint";
import type { CodexAppServerEndpoint } from "./codexAppServerEndpoint";
import {
  loadRuntimeModuleFromDirectory,
  resolveAppRuntimeModulePath,
} from "./runtimeModuleLoader";

export type RuntimeImageValidationOptions = {
  abortSignal?: AbortSignal | null;
  maxPixels: number;
  timeoutMs: number;
};

export type RuntimeImageConversionOptions = RuntimeImageValidationOptions & {
  maxOutputBytes: number;
};

type EnsureOcrRuntime = (options: Record<string, unknown>) => Promise<{
  runtimeDir?: string;
  runtimeVariant?: string;
  packageDir?: string;
  pythonPath?: string;
  prepared?: boolean;
}>;

export type SimplePageRuntime = {
  startServer: (
    options: Record<string, unknown>,
  ) => Promise<{ baseUrl: string; child: unknown; startedByScript: boolean }>;
  stopServer: (server: { child: unknown } | null | undefined) => Promise<void>;
  isModelCached: (options: Record<string, unknown>) => boolean;
  ensureOcrRuntime: EnsureOcrRuntime;
  convertImageToPngBufferWithFfmpeg?: (
    filePath: string,
    options?: { abortSignal?: AbortSignal | null },
  ) => Promise<Buffer>;
  validateImageFileWithFfmpeg: (
    filePath: string,
    options: RuntimeImageValidationOptions,
  ) => Promise<void>;
  convertImageToPngFileWithFfmpeg: (
    filePath: string,
    outputPath: string,
    options: RuntimeImageConversionOptions,
  ) => Promise<void>;
  testModelReply: (
    server: { baseUrl: string },
    options: Record<string, unknown>,
  ) => Promise<{
    outputText: string;
    launchTarget: {
      launchMode: ModelTestResult["launchMode"];
      modelPath?: string | null;
      mmprojPath?: string | null;
    };
  }>;
};

const runtimeCache = new Map<string, SimplePageRuntime>();

export function loadSimplePageRuntime(runtimeDir: string): SimplePageRuntime {
  const cacheKey = resolve(runtimeDir);
  const cachedRuntime = runtimeCache.get(cacheKey);
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const runtimePath = resolveAppRuntimeModulePath(cacheKey, "simplePage");
  const runtime = loadRuntimeModuleFromDirectory(cacheKey, "simplePage");
  assertSimplePageRuntime(runtime, runtimePath);
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}

function assertSimplePageRuntime(
  value: unknown,
  runtimePath: string,
): asserts value is SimplePageRuntime {
  if (!isRecord(value)) {
    throw new Error(`런타임 모듈이 올바르지 않습니다: ${runtimePath} exports`);
  }
  assertFunction(value.startServer, `${runtimePath} startServer`);
  assertFunction(value.stopServer, `${runtimePath} stopServer`);
  assertFunction(value.isModelCached, `${runtimePath} isModelCached`);
  assertFunction(value.testModelReply, `${runtimePath} testModelReply`);
  assertFunction(value.ensureOcrRuntime, `${runtimePath} ensureOcrRuntime`);
  assertOptionalFunction(
    value.convertImageToPngBufferWithFfmpeg,
    `${runtimePath} convertImageToPngBufferWithFfmpeg`,
  );
  assertFunction(
    value.validateImageFileWithFfmpeg,
    `${runtimePath} validateImageFileWithFfmpeg`,
  );
  assertFunction(
    value.convertImageToPngFileWithFfmpeg,
    `${runtimePath} convertImageToPngFileWithFfmpeg`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFunction(value: unknown, label: string): void {
  if (typeof value !== "function") {
    throw new Error(`런타임 모듈이 올바르지 않습니다: ${label}`);
  }
}

function assertOptionalFunction(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "function") {
    throw new Error(`런타임 모듈이 올바르지 않습니다: ${label}`);
  }
}

export async function decodeImageThroughRuntime(
  runtimeDir: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const runtime = loadSimplePageRuntime(runtimeDir);
  if (!runtime.convertImageToPngBufferWithFfmpeg) {
    return null;
  }
  return runtime.convertImageToPngBufferWithFfmpeg(filePath, {
    abortSignal: signal,
  });
}

export function validateImageThroughRuntime(
  runtimeDir: string,
  filePath: string,
  options: { maxPixels: number; timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  return loadSimplePageRuntime(runtimeDir).validateImageFileWithFfmpeg(
    filePath,
    {
      abortSignal: options.signal,
      maxPixels: options.maxPixels,
      timeoutMs: options.timeoutMs,
    },
  );
}

export function convertImageToPngFileThroughRuntime(
  runtimeDir: string,
  sourcePath: string,
  outputPath: string,
  options: {
    maxPixels: number;
    maxOutputBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  return loadSimplePageRuntime(runtimeDir).convertImageToPngFileWithFfmpeg(
    sourcePath,
    outputPath,
    {
      abortSignal: options.signal,
      maxPixels: options.maxPixels,
      maxOutputBytes: options.maxOutputBytes,
      timeoutMs: options.timeoutMs,
    },
  );
}

export function isCodexAppServerEndpoint(
  server:
    | Awaited<ReturnType<SimplePageRuntime["startServer"]>>
    | OpenAICompatibleApiEndpoint
    | CodexAppServerEndpoint
    | null,
): server is CodexAppServerEndpoint {
  return Boolean(
    server && "provider" in server && server.provider === "openai-codex",
  );
}
