import type { TranslationOptions } from "./appSettings";
import { inferApiProviderPreset } from "../shared/apiProviderPresets";

const OLLAMA_UNLOAD_TIMEOUT_MS = 10_000;

export type OllamaModelLifecycleOptions = Pick<
  TranslationOptions,
  "modelProvider" | "apiBaseUrl" | "apiModel"
>;

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status">>;

export type ModelLifecycleWarning = (message: string, detail?: unknown) => void;

const ignoreLifecycleWarning: ModelLifecycleWarning = () => undefined;

export function isOllamaCloudModelId(model: string): boolean {
  return /(?:-cloud|:cloud)$/i.test(model.trim());
}

export function resolveOllamaUnloadUrl(apiBaseUrl: string): string | null {
  if (inferApiProviderPreset(apiBaseUrl) !== "ollama") return null;
  try {
    const url = new URL(apiBaseUrl);
    url.pathname = "/api/generate";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_error) {
    return null;
  }
}

/**
 * Release exactly the local Ollama model selected for the completed session.
 * Ollama Cloud models run remotely and must not receive a local unload call.
 * Cleanup is best-effort so it never replaces the primary job result.
 */
export async function releaseOllamaLocalModel(
  options: OllamaModelLifecycleOptions,
  fetchImpl: FetchLike = fetch,
  onWarning: ModelLifecycleWarning = ignoreLifecycleWarning,
): Promise<boolean> {
  if (options.modelProvider !== "openai-api") return false;
  const model = String(options.apiModel ?? "").trim();
  const unloadUrl = resolveOllamaUnloadUrl(String(options.apiBaseUrl ?? ""));
  if (!model || !unloadUrl || isOllamaCloudModelId(model)) return false;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OLLAMA_UNLOAD_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(unloadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) {
      onWarning("Ollama local model unload request failed", {
        model,
        status: response.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    onWarning("Ollama local model unload request failed", { model, error });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
