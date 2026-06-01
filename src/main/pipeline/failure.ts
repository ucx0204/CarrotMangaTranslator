import type { MangaPage } from "../../shared/types";

export function summarizePage(page: MangaPage): Record<string, unknown> {
  return {
    id: page.id,
    name: page.name,
    imagePath: page.imagePath,
    width: page.width,
    height: page.height,
    analysisStatus: page.analysisStatus
  };
}

export function classifyFailure(error: unknown): string {
  if (isNonRetriableRuntimeError(error)) {
    return "runtime";
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (message.includes("build-page-variant")) {
    return "image-preprocessing";
  }
  if (message.includes("llama-server") || message.includes("bundled llama-server") || message.includes("timed out while waiting")) {
    return "server-startup";
  }
  if (
    message.includes("gemma request failed") ||
    message.includes("openai codex request failed") ||
    message.includes("request transport failed") ||
    message.includes("openai-oauth")
  ) {
    return "model-request";
  }
  if (message.includes("json parse failed")) {
    return "response-json-parse";
  }
  if (message.includes("구조화 형식으로 해석하지 못했습니다") || message.includes("parseable structured payload")) {
    return "overlay-parse";
  }
  if (message.includes("empty response")) {
    return "empty-model-response";
  }
  if (message.includes("bbox 결과를 만들지 못했습니다")) {
    return "empty-overlay-items";
  }
  return "unknown";
}

export function isNonRetriableRuntimeError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "nonRetriable" in error && (error as { nonRetriable?: unknown }).nonRetriable);
}

export function isAbortErrorLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
