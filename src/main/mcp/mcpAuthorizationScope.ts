/** Shared native operation lifetime: permission loss interrupts page handoff as well
 * as preventing the final commit. No task continues after this scope settles. */
export async function withMcpAuthorization<T>(
  authorize: () => void,
  lifetime: AbortSignal | undefined,
  execute: (check: () => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  authorize();
  const controller = new AbortController();
  const signal = lifetime
    ? AbortSignal.any([controller.signal, lifetime])
    : controller.signal;
  const check = () => {
    signal.throwIfAborted();
    authorize();
  };
  const monitor = setInterval(() => {
    try {
      check();
    } catch (error) {
      controller.abort(error);
    }
  }, 250);
  monitor.unref();
  try {
    check();
    return await execute(check, signal);
  } finally {
    clearInterval(monitor);
  }
}
