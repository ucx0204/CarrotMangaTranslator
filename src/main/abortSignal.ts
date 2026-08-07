export function createAbortError(message = "Aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  throw createAbortError();
}

export function isAbortErrorLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as Error & { code?: unknown }).code === "ABORT_ERR")
  );
}
