import type { TranslationOptions } from "../appSettings";
import { getAppPaths } from "../appPaths";
import {
  startCodexAppServerEndpoint,
  stopCodexAppServerEndpoint,
} from "../codexAppServerEndpoint";
import type { CodexAppServerEndpoint } from "../codexAppServerEndpoint";
import {
  createOpenAICompatibleApiEndpoint,
  isOpenAICompatibleApiEndpoint,
  stopOpenAICompatibleApiEndpoint,
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
    animeTextRelations: loadRuntimeModuleFromDirectory(
      runtimeDir,
      "animeTextRelations",
    ),
    simplePage: loadRuntimeModuleFromDirectory(runtimeDir, "simplePage"),
    overlayTools: loadRuntimeModuleFromDirectory(runtimeDir, "overlayTools"),
  };
  assertRuntimeModules(runtime);
  return runtime;
}

function assertRuntimeModules(runtime: {
  animeTextRelations: unknown;
  simplePage: unknown;
  overlayTools: unknown;
}): asserts runtime is RuntimeModules {
  assertRuntimeFunctions(
    runtime.animeTextRelations,
    "anime-text-review-relations.cjs",
    ["hasPotentialAnimeTextRelation", "qualifyAnimeTextRelationRegionIds"],
  );
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
    return startCodexAppServerEndpoint(options);
  }
  if (options.modelProvider === "openai-api") {
    return createOpenAICompatibleApiEndpoint(options);
  }
  return runtime.simplePage.startServer(options);
}

export class ModelEndpointSession {
  private endpoint: ModelEndpointHandle | null;
  private disposed = false;
  private closedForUse = false;
  private disposal: Promise<void> | null = null;
  private readonly cleanupOptions: Pick<
    TranslationOptions,
    "modelProvider" | "apiBaseUrl" | "apiModel"
  >;

  constructor(
    private readonly runtime: RuntimeModules,
    endpoint: ModelEndpointHandle,
    options: TranslationOptions,
    private readonly onCleanupWarning?: (
      message: string,
      detail?: unknown,
    ) => void,
  ) {
    this.endpoint = endpoint;
    this.cleanupOptions = {
      modelProvider: options.modelProvider,
      apiBaseUrl: options.apiBaseUrl,
      apiModel: options.apiModel,
    };
  }

  get handle(): ModelEndpointHandle {
    if (!this.endpoint || this.closedForUse) {
      throw new Error("모델 엔드포인트가 이미 정리 중이거나 종료되었습니다.");
    }
    return this.endpoint;
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.disposal) return this.disposal;
    this.closedForUse = true;
    // Keep the cleanup target until shutdown succeeds. Concurrent callers must
    // await it; a failed shutdown remains retryable but never reusable for work.
    this.disposal = stopModelEndpoint(
      this.runtime,
      this.endpoint,
      this.cleanupOptions,
      this.onCleanupWarning,
    )
      .then(() => {
        this.endpoint = null;
        this.disposed = true;
      })
      .finally(() => {
        this.disposal = null;
      });
    return this.disposal;
  }
}

export async function startModelEndpointSession(
  runtime: RuntimeModules,
  options: TranslationOptions,
  onCleanupWarning?: (message: string, detail?: unknown) => void,
): Promise<ModelEndpointSession> {
  return new ModelEndpointSession(
    runtime,
    await startModelEndpoint(runtime, options),
    options,
    onCleanupWarning,
  );
}

async function stopModelEndpoint(
  runtime: RuntimeModules,
  endpoint: ModelEndpointHandle | null | undefined,
  options: Pick<
    TranslationOptions,
    "modelProvider" | "apiBaseUrl" | "apiModel"
  >,
  onCleanupWarning?: (message: string, detail?: unknown) => void,
): Promise<void> {
  if (isCodexAppServerEndpoint(endpoint)) {
    await stopCodexAppServerEndpoint(endpoint);
    return;
  }
  if (isOpenAICompatibleApiEndpoint(endpoint)) {
    await stopOpenAICompatibleApiEndpoint(options, onCleanupWarning);
    return;
  }
  await runtime.simplePage.stopServer(endpoint);
}

function isCodexAppServerEndpoint(
  endpoint: ModelEndpointHandle | null | undefined,
): endpoint is CodexAppServerEndpoint {
  return Boolean(
    endpoint && "provider" in endpoint && endpoint.provider === "openai-codex",
  );
}
