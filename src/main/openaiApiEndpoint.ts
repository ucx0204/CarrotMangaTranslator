import type { TranslationOptions } from "./appSettings";
import { releaseOllamaLocalModel } from "./ollamaModelLifecycle";

export type OpenAICompatibleApiEndpoint = {
  baseUrl: string;
  child: null;
  startedByScript: false;
  provider: "openai-api";
};

export function createOpenAICompatibleApiEndpoint(
  options: TranslationOptions,
): OpenAICompatibleApiEndpoint {
  return {
    baseUrl: options.apiBaseUrl,
    child: null,
    startedByScript: false,
    provider: "openai-api",
  };
}

export function isOpenAICompatibleApiEndpoint(
  endpoint: unknown,
): endpoint is OpenAICompatibleApiEndpoint {
  if (!endpoint || typeof endpoint !== "object" || !("provider" in endpoint)) {
    return false;
  }
  return endpoint.provider === "openai-api";
}

export async function stopOpenAICompatibleApiEndpoint(
  options: Pick<
    TranslationOptions,
    "modelProvider" | "apiBaseUrl" | "apiModel"
  >,
  onWarning?: (message: string, detail?: unknown) => void,
): Promise<void> {
  await releaseOllamaLocalModel(options, fetch, onWarning);
}
