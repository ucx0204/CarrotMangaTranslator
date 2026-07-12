import { join } from "node:path";
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
    simplePage: require(
      join(runtimeDir, "simple-page-translate.cjs"),
    ) as RuntimeModules["simplePage"],
    overlayTools: require(
      join(runtimeDir, "overlay-parser.cjs"),
    ) as RuntimeModules["overlayTools"],
  };
  assertRuntimeModules(cachedRuntime);
  return cachedRuntime;
}

function assertRuntimeModules(runtime: RuntimeModules): void {
  assertFunction(
    runtime.simplePage?.collectOcrBboxHints,
    "simple-page-translate.cjs collectOcrBboxHints",
  );
  assertFunction(
    runtime.simplePage?.requestTranslation,
    "simple-page-translate.cjs requestTranslation",
  );
  assertFunction(
    runtime.simplePage?.saveArtifacts,
    "simple-page-translate.cjs saveArtifacts",
  );
  assertFunction(
    runtime.simplePage?.startServer,
    "simple-page-translate.cjs startServer",
  );
  assertFunction(
    runtime.simplePage?.stopServer,
    "simple-page-translate.cjs stopServer",
  );
  assertFunction(
    runtime.simplePage?.isModelCached,
    "simple-page-translate.cjs isModelCached",
  );
  assertFunction(
    runtime.overlayTools?.normalizeItems,
    "overlay-parser.cjs normalizeItems",
  );
  assertFunction(
    runtime.overlayTools?.normalizeRegionSingleItem,
    "overlay-parser.cjs normalizeRegionSingleItem",
  );
  assertFunction(
    runtime.overlayTools?.parseJsonLenient,
    "overlay-parser.cjs parseJsonLenient",
  );
  assertFunction(
    runtime.overlayTools?.parseRegionSingleItem,
    "overlay-parser.cjs parseRegionSingleItem",
  );
}

function assertFunction(value: unknown, label: string): void {
  if (typeof value !== "function") {
    throw new Error(`런타임 모듈이 올바르지 않습니다: ${label}`);
  }
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
