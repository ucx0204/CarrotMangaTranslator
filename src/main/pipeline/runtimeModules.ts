import { join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import { getAppPaths } from "../appPaths";
import { startOpenAIOAuthEndpoint, stopOpenAIOAuthEndpoint } from "../openaiOauthEndpoint";
import type { OpenAIOAuthEndpoint } from "../openaiOauthEndpoint";
import type { ModelEndpointHandle, RuntimeModules } from "./types";

let cachedRuntimeDir: string | null = null;
let cachedRuntime: RuntimeModules | null = null;

export function loadRuntimeModules(): RuntimeModules {
  const runtimeDir = getAppPaths().runtimeDir;
  if (cachedRuntime && cachedRuntimeDir === runtimeDir) {
    return cachedRuntime;
  }

  cachedRuntimeDir = runtimeDir;
  cachedRuntime = {
    simplePage: require(join(runtimeDir, "simple-page-translate.cjs")) as RuntimeModules["simplePage"],
    overlayTools: require(join(runtimeDir, "overlay-parser.cjs")) as RuntimeModules["overlayTools"]
  };
  return cachedRuntime;
}

export async function startModelEndpoint(runtime: RuntimeModules, options: TranslationOptions): Promise<ModelEndpointHandle> {
  if (options.modelProvider === "openai-codex") {
    return startOpenAIOAuthEndpoint(options);
  }
  return runtime.simplePage.startServer(options);
}

export async function stopModelEndpoint(runtime: RuntimeModules, endpoint: ModelEndpointHandle | null | undefined): Promise<void> {
  if (isOpenAIOAuthEndpoint(endpoint)) {
    await stopOpenAIOAuthEndpoint(endpoint);
    return;
  }
  await runtime.simplePage.stopServer(endpoint);
}

export function isOpenAIOAuthEndpoint(endpoint: ModelEndpointHandle | null | undefined): endpoint is OpenAIOAuthEndpoint {
  return Boolean(endpoint && "provider" in endpoint && endpoint.provider === "openai-codex");
}
