export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    void Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

export function throwPageExportCleanupError(
  renderFailure: { error: unknown } | null,
  cleanupErrors: unknown[],
): void {
  if (cleanupErrors.length === 0) return;
  if (renderFailure) {
    const { error: renderError } = renderFailure;
    throw new AggregateError(
      [renderError, ...cleanupErrors],
      `PNG export failed: ${errorMessage(renderError)}. Window cleanup also failed: ${cleanupErrors.map(errorMessage).join("; ")}`,
      { cause: renderError },
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(
    cleanupErrors,
    `PNG export window cleanup failed: ${cleanupErrors.map(errorMessage).join("; ")}`,
    { cause: cleanupErrors[0] },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
