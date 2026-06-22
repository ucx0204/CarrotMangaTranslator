import type { MangaPage } from "../../shared/libraryTypes";

const FAILURE_MESSAGE_RULES = [
  {
    category: "image-preprocessing",
    terms: ["build-page-variant"],
  },
  {
    category: "server-startup",
    terms: ["llama-server", "bundled llama-server", "timed out while waiting"],
  },
  {
    category: "model-request",
    terms: [
      "gemma request failed",
      "openai codex request failed",
      "api 오류",
      "request transport failed",
      "openai-oauth",
    ],
  },
  {
    category: "response-json-parse",
    terms: ["json parse failed"],
  },
  {
    category: "overlay-parse",
    terms: [
      "구조화 형식으로 해석하지 못했습니다",
      "parseable structured payload",
    ],
  },
  {
    category: "empty-model-response",
    terms: ["empty response"],
  },
  {
    category: "empty-overlay-items",
    terms: ["bbox 결과를 만들지 못했습니다"],
  },
] as const;

export function summarizePage(page: MangaPage): Record<string, unknown> {
  return {
    id: page.id,
    name: page.name,
    imagePath: page.imagePath,
    width: page.width,
    height: page.height,
    analysisStatus: page.analysisStatus,
  };
}

export function classifyFailure(error: unknown): string {
  const explicitCategory = readFailureCategory(error);
  if (explicitCategory) {
    return explicitCategory;
  }
  if (isNonRetriableRuntimeError(error)) {
    return "runtime";
  }
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return classifyFailureMessage(message);
}

function readFailureCategory(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "failureCategory" in error &&
    typeof (error as { failureCategory?: unknown }).failureCategory === "string"
  ) {
    return (error as { failureCategory: string }).failureCategory;
  }
  return null;
}

function classifyFailureMessage(message: string): string {
  return (
    FAILURE_MESSAGE_RULES.find((rule) =>
      rule.terms.some((term) => message.includes(term)),
    )?.category ?? "unknown"
  );
}

export function isNonRetriableRuntimeError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "nonRetriable" in error &&
    (error as { nonRetriable?: unknown }).nonRetriable,
  );
}

export function isAbortErrorLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
