import type { TranslationOptions } from "../appSettings";
import { getAppPaths } from "../appPaths";
import {
  startOpenAIOAuthEndpoint,
  stopOpenAIOAuthEndpoint,
} from "../openaiOauthEndpoint";
import type { OpenAIOAuthEndpoint } from "../openaiOauthEndpoint";
import {
  createOpenAICompatibleApiEndpoint,
  isOpenAICompatibleApiEndpoint,
} from "../openaiApiEndpoint";
import {
  assertRuntimeFunctions,
  loadRuntimeModuleFromDirectory,
} from "../runtimeModuleLoader";
import type { ModelEndpointHandle, RuntimeModules } from "./types";

export function loadRuntimeModules(
  runtimeDir: string = getAppPaths().runtimeDir,
): RuntimeModules {
  const runtime = {
    simplePage: loadRuntimeModuleFromDirectory(runtimeDir, "simplePage"),
    overlayTools: loadRuntimeModuleFromDirectory(runtimeDir, "overlayTools"),
  };
  assertRuntimeModules(runtime);
  return runtime;
}

function assertRuntimeModules(runtime: {
  simplePage: unknown;
  overlayTools: unknown;
}): asserts runtime is RuntimeModules {
  assertRuntimeFunctions(runtime.simplePage, "simple-page-translate.cjs", [
    "collectOcrBboxHints",
    "requestTranslation",
    "saveArtifacts",
    "startServer",
    "stopServer",
    "isModelCached",
  ]);
  assertRuntimeFunctions(runtime.overlayTools, "overlay-parser.cjs", [
    "normalizeItems",
    "normalizeRegionSingleItem",
    "parseJsonLenient",
    "parseRegionSingleItem",
  ]);
}

async function startModelEndpoint(
  runtime: RuntimeModules,
  options: TranslationOptions,
): Promise<ModelEndpointHandle> {
  if (options.modelProvider === "openai-codex") {
    return startOpenAIOAuthEndpoint(options);
  }
  if (options.modelProvider === "openai-api") {
    return createOpenAICompatibleApiEndpoint(options);
  }
  return runtime.simplePage.startServer(options);
}

export class ModelEndpointSession {
  private endpoint: ModelEndpointHandle | null;
  private disposed = false;

  constructor(
    private readonly runtime: RuntimeModules,
    endpoint: ModelEndpointHandle,
  ) {
    this.endpoint = endpoint;
  }

  get handle(): ModelEndpointHandle {
    if (!this.endpoint) {
      throw new Error("모델 엔드포인트가 이미 정리되었습니다.");
    }
    return this.endpoint;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const endpoint = this.endpoint;
    this.endpoint = null;
    await stopModelEndpoint(this.runtime, endpoint);
  }
}

export async function startModelEndpointSession(
  runtime: RuntimeModules,
  options: TranslationOptions,
): Promise<ModelEndpointSession> {
  return new ModelEndpointSession(
    runtime,
    await startModelEndpoint(runtime, options),
  );
}

async function stopModelEndpoint(
  runtime: RuntimeModules,
  endpoint: ModelEndpointHandle | null | undefined,
): Promise<void> {
  if (isOpenAIOAuthEndpoint(endpoint)) {
    await stopOpenAIOAuthEndpoint(endpoint);
    return;
  }
  if (isOpenAICompatibleApiEndpoint(endpoint)) {
    return;
  }
  await runtime.simplePage.stopServer(endpoint);
}

function isOpenAIOAuthEndpoint(
  endpoint: ModelEndpointHandle | null | undefined,
): endpoint is OpenAIOAuthEndpoint {
  return Boolean(
    endpoint && "provider" in endpoint && endpoint.provider === "openai-codex",
  );
}
