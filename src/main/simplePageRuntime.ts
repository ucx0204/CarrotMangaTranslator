import { join } from "node:path";
import type { ModelTestResult } from "../shared/types";
import type { OpenAIOAuthEndpoint } from "./openaiOauthEndpoint";

export type SimplePageRuntime = {
  startServer: (options: Record<string, unknown>) => Promise<{ baseUrl: string; child: unknown; startedByScript: boolean }>;
  stopServer: (server: { child: unknown } | null | undefined) => Promise<void>;
  isModelCached: (options: Record<string, unknown>) => boolean;
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

let cachedSimplePageRuntime: SimplePageRuntime | null = null;

export function loadSimplePageRuntime(runtimeDir: string): SimplePageRuntime {
  if (cachedSimplePageRuntime) {
    return cachedSimplePageRuntime;
  }

  cachedSimplePageRuntime = require(join(runtimeDir, "simple-page-translate.cjs")) as SimplePageRuntime;
  return cachedSimplePageRuntime;
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
