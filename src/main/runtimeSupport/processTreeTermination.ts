import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export const PROCESS_TREE_FORCE_EXIT_TIMEOUT_MS = 3_000;
export const PROCESS_TREE_POLL_INTERVAL_MS = 25;

export type ProcessTreeTerminationDetail = {
  pid: number | null;
  platform: NodeJS.Platform;
  method:
    | "already-exited"
    | "posix-process-group"
    | "posix-direct-fallback"
    | "windows-taskkill";
};

export type ChildExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export function shouldSpawnInOwnProcessGroup(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

export function createChildExitReceipt(child: ChildProcess): {
  promise: Promise<ChildExitResult>;
  hasExited: () => boolean;
} {
  let observedExit = hasChildExited(child) || child.pid === undefined;
  let result: ChildExitResult = {
    code: child.exitCode,
    signal: child.signalCode,
  };

  if (observedExit) {
    return {
      promise: Promise.resolve(result),
      hasExited: () => true,
    };
  }

  let resolveExit: (value: ChildExitResult) => void = () => undefined;
  const promise = new Promise<ChildExitResult>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (observedExit) {
      return;
    }
    observedExit = true;
    result = { code, signal };
    child.removeListener("exit", onExit);
    child.removeListener("close", onClose);
    child.removeListener("error", onError);
    resolveExit(result);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
    finish(code, signal);
  const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
    finish(code, signal);
  const onError = () => {
    if (child.pid === undefined) {
      finish(child.exitCode, child.signalCode);
    }
  };

  child.once("exit", onExit);
  child.once("close", onClose);
  child.once("error", onError);

  if (hasChildExited(child)) {
    finish(child.exitCode, child.signalCode);
  }

  return {
    promise,
    hasExited: () => observedExit || hasChildExited(child),
  };
}

export async function forceTerminateChildProcessTree(
  child: ChildProcess,
  options: { timeoutMs?: number } = {},
): Promise<ProcessTreeTerminationDetail> {
  const platform = process.platform;
  const timeoutMs = normalizeTimeout(
    options.timeoutMs ?? PROCESS_TREE_FORCE_EXIT_TIMEOUT_MS,
  );
  const pid = child.pid ?? null;

  if (pid === null) {
    return { pid, platform, method: "already-exited" };
  }

  if (platform === "win32") {
    if (hasChildExited(child)) {
      return { pid, platform, method: "already-exited" };
    }
    await terminateWindowsProcessTree(child, pid, timeoutMs);
    return { pid, platform, method: "windows-taskkill" };
  }

  const groupAlive = isPosixProcessGroupAlive(pid);
  if (!groupAlive && hasChildExited(child)) {
    return { pid, platform, method: "already-exited" };
  }

  const method = await terminatePosixProcessTree(
    child,
    pid,
    timeoutMs,
    groupAlive,
  );
  return { pid, platform, method };
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminatePosixProcessTree(
  child: ChildProcess,
  pid: number,
  timeoutMs: number,
  groupInitiallyAlive: boolean,
): Promise<"posix-process-group" | "posix-direct-fallback"> {
  const deadline = Date.now() + timeoutMs;
  let method: "posix-process-group" | "posix-direct-fallback" =
    "posix-process-group";
  let signalError: Error | null = null;

  if (groupInitiallyAlive) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (readErrnoCode(error) !== "ESRCH") {
        signalError = toError(error);
        method = "posix-direct-fallback";
        tryDirectSigkill(child);
      }
    }
  } else {
    method = "posix-direct-fallback";
    tryDirectSigkill(child);
  }

  const terminated = await waitUntil(
    () => hasChildExited(child) && !isPosixProcessGroupAlive(pid),
    deadline,
  );
  if (terminated) {
    return method;
  }

  const detail = signalError ? ` ${signalError.message}` : "";
  throw new Error(
    `POSIX process tree ${pid} did not terminate within ${timeoutMs}ms.${detail}`,
  );
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return readErrnoCode(error) !== "ESRCH";
  }
}

async function terminateWindowsProcessTree(
  child: ChildProcess,
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let killer: ChildProcess;
  try {
    const taskkillPath = resolveTaskkillPath();
    killer = spawn(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      env: process.env,
    });
  } catch (error) {
    await failWindowsTermination(child, pid, deadline, error);
    return;
  }

  let code: number | null;
  try {
    code = await waitForProcessClose(killer, remainingMs(deadline));
  } catch (error) {
    await failWindowsTermination(child, pid, deadline, error);
    return;
  }

  if (code !== 0) {
    tryDirectSigkill(child);
    await waitForChildExit(child, remainingMs(deadline));
    throw new Error(
      `Windows process tree ${pid} termination command exited with code ${code}.`,
    );
  }

  if (!(await waitForChildExit(child, remainingMs(deadline)))) {
    tryDirectSigkill(child);
    throw new Error(
      `Windows process tree ${pid} direct child did not exit within ${timeoutMs}ms.`,
    );
  }
}

async function failWindowsTermination(
  child: ChildProcess,
  pid: number,
  deadline: number,
  error: unknown,
): Promise<never> {
  tryDirectSigkill(child);
  await waitForChildExit(child, remainingMs(deadline));
  throw new Error(
    `Windows process tree ${pid} termination command failed: ${toError(error).message}`,
    { cause: error },
  );
}

function resolveTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  if (!systemRoot || systemRoot.trim().length === 0) {
    throw new Error("Windows SystemRoot is unavailable.");
  }
  return join(systemRoot, "System32", "taskkill.exe");
}

function waitForProcessClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  if (timeoutMs <= 0) {
    return Promise.reject(new Error("Process close deadline expired."));
  }

  return new Promise((resolve, reject) => {
    const finish = (error: Error | null, code: number | null = null) => {
      clearTimeout(timeout);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve(code);
      }
    };
    const onClose = (code: number | null) => finish(null, code);
    const onError = (error: Error) => finish(error);
    const timeout = setTimeout(
      () => finish(new Error(`Process close exceeded ${timeoutMs}ms.`)),
      timeoutMs,
    );
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasChildExited(child)) {
    return true;
  }
  if (timeoutMs <= 0) {
    return false;
  }

  const receipt = createChildExitReceipt(child);
  return await Promise.race([
    receipt.promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function waitUntil(
  predicate: () => boolean,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remainingMs(deadline)));
  }
  return predicate();
}

function tryDirectSigkill(child: ChildProcess): void {
  if (hasChildExited(child)) {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch (error) {
    void error;
    // The caller still verifies actual exit and reports failure if it remains alive.
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Process tree termination timeout must be a positive number.",
    );
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)));
}

function readErrnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
