import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  DataRootInstanceLockHeldError,
  acquireDataRootInstanceLock,
  isProcessAliveFailClosed,
} from "../../src/main/dataRootInstanceLock";

const [dataRoot, resultPath, releaseSignalPath] = process.argv.slice(2);
if (!dataRoot || !resultPath || !releaseSignalPath) {
  throw new Error("Expected dataRoot, resultPath, and releaseSignalPath.");
}

try {
  const lease = acquireDataRootInstanceLock(dataRoot, {
    now: () => new Date(),
    createToken: () => randomUUID(),
    getHostname: () => hostname(),
    processId: process.pid,
    executablePath: process.execPath,
    appVersion: "process-test",
    isProcessAlive: isProcessAliveFailClosed,
  });
  writeResult({
    status: "acquired",
    token: lease.owner.token,
    pid: process.pid,
  });
  await waitForReleaseSignal(releaseSignalPath);
  lease.release();
  process.exitCode = 0;
} catch (error) {
  if (error instanceof DataRootInstanceLockHeldError) {
    writeResult({
      status: "locked",
      reason: error.reason,
      ownerToken: error.owner.token,
      ownerPid: error.owner.pid,
    });
    process.exitCode = 20;
  } else {
    writeResult({
      status: "error",
      message:
        error instanceof Error ? error.stack || error.message : String(error),
    });
    process.exitCode = 30;
  }
}

function writeResult(value: unknown): void {
  writeFileSync(resultPath, `${JSON.stringify(value)}\n`, "utf8");
}

async function waitForReleaseSignal(signalPath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(signalPath)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the release signal.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
