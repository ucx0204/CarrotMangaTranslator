import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { DataRootInstanceLockLease } from "./dataRootInstanceLock";

let installedLease: DataRootInstanceLockLease | null = null;
let processExitListener: (() => void) | null = null;

export function installDataRootInstanceLockLease(
  lease: DataRootInstanceLockLease,
): void {
  if (installedLease) {
    throw new Error("A data-root instance lock lease is already installed.");
  }

  const releaseAtProcessExit = (): void => {
    try {
      lease.release();
    } catch (error) {
      console.error(
        "Failed to release data-root lock during process exit",
        error,
      );
    }
  };

  installedLease = lease;
  processExitListener = releaseAtProcessExit;
  // Keep the lease through the full Electron shutdown sequence. app.quit() can
  // still be cancelled by a BrowserWindow beforeunload handler, and Electron
  // storage under dataRoot may remain active until process termination.
  // The Node "exit" event is the authoritative normal-shutdown release boundary;
  // this callback must remain synchronous.
  process.once("exit", releaseAtProcessExit);
}

export function assertDataRootInstanceLockHeld(dataRoot: string): void {
  if (!installedLease) {
    throw new Error("The data-root instance lock lease is not installed.");
  }
  const canonicalDataRoot = realpathSync.native(resolve(dataRoot));
  if (installedLease.dataRoot !== canonicalDataRoot) {
    throw new Error(
      `The installed data-root lock does not match the main-process data root: ${canonicalDataRoot}`,
    );
  }
}

export function releaseDataRootInstanceLockLease(): void {
  if (!installedLease) {
    return;
  }

  installedLease.release();
  if (processExitListener) {
    process.removeListener("exit", processExitListener);
  }
  installedLease = null;
  processExitListener = null;
}

export function hasDataRootInstanceLockLease(): boolean {
  return installedLease !== null;
}

export function resetDataRootInstanceLockStateForTests(): void {
  if (processExitListener) {
    process.removeListener("exit", processExitListener);
  }
  installedLease = null;
  processExitListener = null;
}
