import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataRootInstanceLockLease } from "../src/main/dataRootInstanceLock";
import {
  assertDataRootInstanceLockHeld,
  hasDataRootInstanceLockLease,
  installDataRootInstanceLockLease,
  releaseDataRootInstanceLockLease,
  resetDataRootInstanceLockStateForTests,
} from "../src/main/dataRootInstanceLockState";

const roots: string[] = [];

beforeEach(() => {
  resetDataRootInstanceLockStateForTests();
});

afterEach(() => {
  resetDataRootInstanceLockStateForTests();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("data-root instance lock state", () => {
  it("installs one lease, asserts its canonical root, and releases it", () => {
    const root = makeRoot();
    const lease = makeLease(root);
    const initialExitListeners = process.listenerCount("exit");

    installDataRootInstanceLockLease(lease);

    expect(hasDataRootInstanceLockLease()).toBe(true);
    expect(process.listenerCount("exit")).toBe(initialExitListeners + 1);
    expect(() => assertDataRootInstanceLockHeld(root)).not.toThrow();

    releaseDataRootInstanceLockLease();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(hasDataRootInstanceLockLease()).toBe(false);
    expect(process.listenerCount("exit")).toBe(initialExitListeners);
  });

  it("releases the lease synchronously from the process exit listener", () => {
    const root = makeRoot();
    const lease = makeLease(root);
    const initialExitListeners = new Set(process.rawListeners("exit"));

    installDataRootInstanceLockLease(lease);

    const addedExitListeners = process
      .rawListeners("exit")
      .filter((listener) => !initialExitListeners.has(listener));
    expect(addedExitListeners).toHaveLength(1);

    addedExitListeners[0]?.call(process, 0);

    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("rejects a second installed lease", () => {
    const root = makeRoot();
    installDataRootInstanceLockLease(makeLease(root));

    expect(() => installDataRootInstanceLockLease(makeLease(root))).toThrow(
      /already installed/i,
    );
  });

  it("rejects a missing or mismatched lease", () => {
    const root = makeRoot();
    const otherRoot = makeRoot();

    expect(() => assertDataRootInstanceLockHeld(root)).toThrow(
      /not installed/i,
    );
    installDataRootInstanceLockLease(makeLease(root));
    expect(() => assertDataRootInstanceLockHeld(otherRoot)).toThrow(
      /does not match/i,
    );
  });

  it("retains the lease and exit fallback when normal release fails", () => {
    const root = makeRoot();
    const failure = new Error("release failed");
    const lease = makeLease(
      root,
      vi.fn(() => {
        throw failure;
      }),
    );
    const initialExitListeners = process.listenerCount("exit");
    installDataRootInstanceLockLease(lease);

    expect(() => releaseDataRootInstanceLockLease()).toThrow(failure);
    expect(hasDataRootInstanceLockLease()).toBe(true);
    expect(process.listenerCount("exit")).toBe(initialExitListeners + 1);
  });

  it("makes release without an installed lease a no-op", () => {
    expect(() => releaseDataRootInstanceLockLease()).not.toThrow();
  });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mgt-instance-state-"));
  roots.push(root);
  return root;
}

function makeLease(root: string, release = vi.fn()): DataRootInstanceLockLease {
  const canonicalRoot = realpathSync.native(root);
  return {
    dataRoot: canonicalRoot,
    lockDirectory: join(canonicalRoot, ".mgt-instance-lock"),
    owner: {
      schemaVersion: 1,
      token: "owner-token",
      pid: 123,
      hostname: "HOST-A",
      startedAt: "2026-08-06T12:00:00.000Z",
      executablePath: "C:\\app.exe",
      appVersion: "1.10.1-test",
      dataRoot: canonicalRoot,
    },
    release,
  };
}
