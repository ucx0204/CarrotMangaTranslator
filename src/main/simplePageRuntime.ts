import { join, resolve } from "node:path";
import type { ModelTestResult } from "../shared/types";
import type { OpenAIOAuthEndpoint } from "./openaiOauthEndpoint";

export type SimplePageRuntime = {
  startServer: (options: Record<string, unknown>) => Promise<{ baseUrl: string; child: unknown; startedByScript: boolean }>;
  stopServer: (server: { child: unknown } | null | undefined) => Promise<void>;
  isModelCached: (options: Record<string, unknown>) => boolean;
  ensurePaddleOcrRuntime?: (options: Record<string, unknown>) => Promise<{
    runtimeDir?: string;
    runtimeVariant?: string;
    packageDir?: string;
    pythonPath?: string;
    prepared?: boolean;
  }>;
  convertImageToPngBufferWithFfmpeg?: (filePath: string) => Promise<Buffer>;
  testModelReply: (server: { baseUrl: string }, options: Record<string, unknown>) => Promise<{
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

  const runtime = require(join(cacheKey, "simple-page-translate.cjs")) as SimplePageRuntime;
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}

export async function decodeImageThroughRuntime(runtimeDir: string, filePath: string): Promise<Buffer | null> {
  const runtime = loadSimplePageRuntime(runtimeDir);
  if (!runtime.convertImageToPngBufferWithFfmpeg) {
    return null;
  }
  return runtime.convertImageToPngBufferWithFfmpeg(filePath);
}

export function isOpenAIOAuthEndpoint(
  server: Awaited<ReturnType<SimplePageRuntime["startServer"]>> | OpenAIOAuthEndpoint | null
): server is OpenAIOAuthEndpoint {
  return Boolean(server && "provider" in server && server.provider === "openai-codex");
}
