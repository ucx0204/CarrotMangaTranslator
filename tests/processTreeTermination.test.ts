import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JSON_WORKER_SHUTDOWN_GRACE_MS,
  JsonLinesWorkerClient,
} from "../src/main/runtimeSupport/jsonLinesWorkerClient";
import {
  PROCESS_TREE_FORCE_EXIT_TIMEOUT_MS,
  PROCESS_TREE_POLL_INTERVAL_MS,
  shouldSpawnInOwnProcessGroup,
} from "../src/main/runtimeSupport/processTreeTermination";

const parentScript = join(__dirname, "fixtures", "jsonWorkerTreeParent.cjs");
const grandchildScript = join(
  __dirname,
  "fixtures",
  "jsonWorkerTreeGrandchild.cjs",
);

describe("process-tree termination", () => {
  it("keeps the documented bounded lifecycle timings and process-group policy", () => {
    expect(JSON_WORKER_SHUTDOWN_GRACE_MS).toBe(1_500);
    expect(PROCESS_TREE_FORCE_EXIT_TIMEOUT_MS).toBe(3_000);
    expect(PROCESS_TREE_POLL_INTERVAL_MS).toBe(25);
    expect(shouldSpawnInOwnProcessGroup("darwin")).toBe(true);
    expect(shouldSpawnInOwnProcessGroup("linux")).toBe(true);
    expect(shouldSpawnInOwnProcessGroup("win32")).toBe(false);
  });

  it("removes both the worker parent and its grandchild after request abort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jlwc-tree-"));
    const pidFile = join(dir, "grandchild.pid");
    const heartbeatFile = join(dir, "heartbeat.txt");
    let parentPid: number | null = null;
    let grandchildPid: number | null = null;
    const controller = new AbortController();
    const client = new JsonLinesWorkerClient<{ type: string }>({
      executable: process.execPath,
      args: [parentScript, grandchildScript, pidFile, heartbeatFile],
      env: process.env,
      workerName: "Process tree fixture",
      requestTimeoutMs: 5_000,
      buildExitError: (code, stderr) => new Error(`exit ${code} ${stderr}`),
      buildNotRunningError: (stderr) => new Error(`not running ${stderr}`),
      sanitizeStderr: (text) => text,
      onStderr: () => {},
      onSpawn: (pid) => {
        parentPid = pid;
      },
      onTerminationError: () => {},
    });

    try {
      const handle = client.startRequest({ type: "hang" }, controller.signal);
      grandchildPid = await waitForPidFile(pidFile, 5_000);
      await waitForCondition(
        () => existsSync(heartbeatFile) && statSync(heartbeatFile).size > 0,
        5_000,
      );
      expect(isProcessAlive(parentPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      controller.abort();
      await expect(withHardCap(handle.response, 6_000)).rejects.toMatchObject({
        name: "AbortError",
      });
      await withHardCap(client.dispose(), 6_000);
      await waitForCondition(
        () => !isProcessAlive(parentPid) && !isProcessAlive(grandchildPid),
        3_000,
      );

      expect(isProcessAlive(parentPid)).toBe(false);
      expect(isProcessAlive(grandchildPid)).toBe(false);
      const stoppedHeartbeat = readFileSync(heartbeatFile, "utf8");
      await delay(180);
      expect(readFileSync(heartbeatFile, "utf8")).toBe(stoppedHeartbeat);
    } finally {
      cleanupTree(parentPid, grandchildPid);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitForPidFile(
  path: string,
  timeoutMs: number,
): Promise<number> {
  let pid: number | null = null;
  await waitForCondition(() => {
    if (!existsSync(path)) {
      return false;
    }
    const parsed = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return false;
    }
    pid = parsed;
    return true;
  }, timeoutMs);
  if (pid === null) {
    throw new Error(`PID file did not contain a valid process id: ${path}`);
  }
  return pid;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  if (!predicate()) {
    throw new Error(`condition did not become true within ${timeoutMs}ms`);
  }
}

async function withHardCap<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`test hard cap exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return readCode(error) !== "ESRCH";
  }
}

function cleanupTree(
  parentPid: number | null,
  grandchildPid: number | null,
): void {
  if (process.platform !== "win32" && parentPid !== null) {
    try {
      process.kill(-parentPid, "SIGKILL");
    } catch (error) {
      void error;
      // Best-effort test cleanup only; direct PID cleanup follows.
    }
  }
  for (const pid of [grandchildPid, parentPid]) {
    if (pid === null || !isProcessAlive(pid)) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      void error;
      // Best-effort test cleanup only.
    }
  }
}

function readCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
