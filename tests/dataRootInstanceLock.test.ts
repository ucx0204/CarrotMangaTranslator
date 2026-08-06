import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATA_ROOT_INSTANCE_LOCK_DIRECTORY,
  DATA_ROOT_INSTANCE_LOCK_OWNER_FILE,
  DataRootInstanceLockHeldError,
  DataRootInstanceLockInvalidError,
  DataRootInstanceLockLostError,
  acquireDataRootInstanceLock,
  canonicalizeDataRoot,
  isProcessAliveFailClosed,
  type DataRootInstanceLockOwner,
  type DataRootInstanceLockRuntime,
} from "../src/main/dataRootInstanceLock";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("data-root instance lock", () => {
  it("publishes a complete canonical owner and removes its candidate", () => {
    const root = makeRoot();
    const runtime = makeRuntime({ token: "owner-a", pid: 101 });

    const lease = acquireDataRootInstanceLock(root, runtime);
    const owner = readCanonicalOwner(root);

    expect(owner).toEqual(lease.owner);
    expect(owner).toMatchObject({
      schemaVersion: 1,
      token: "owner-a",
      pid: 101,
      hostname: "HOST-A",
      appVersion: "1.10.1-test",
      dataRoot: canonicalizeDataRoot(root),
    });
    expect(instanceSidecars(root, ".mgt-instance-candidate-")).toEqual([]);

    lease.release();
    expect(existsSync(lockDirectory(root))).toBe(false);
  });

  it("blocks a second same-host process while the first owner is live", () => {
    const root = makeRoot();
    const first = acquireDataRootInstanceLock(
      root,
      makeRuntime({ token: "owner-a", pid: 101 }),
    );

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({
          token: "owner-b",
          pid: 202,
          isProcessAlive: (pid) => pid === 101,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_ROOT_INSTANCE_LOCK_HELD",
        reason: "live-process",
      }),
    );
    expect(readCanonicalOwner(root).token).toBe("owner-a");
    expect(instanceSidecars(root, ".mgt-instance-candidate-")).toEqual([]);

    first.release();
  });

  it("supports release, reacquisition, and idempotent release", () => {
    const root = makeRoot();
    const first = acquireDataRootInstanceLock(
      root,
      makeRuntime({ token: "owner-a", pid: 101 }),
    );

    first.release();
    first.release();
    expect(existsSync(lockDirectory(root))).toBe(false);

    const second = acquireDataRootInstanceLock(
      root,
      makeRuntime({ token: "owner-b", pid: 202 }),
    );
    expect(second.owner.token).toBe("owner-b");
    second.release();
  });

  it("reclaims a same-host dead-PID lock through the reclaim marker", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "dead-owner", pid: 404 }),
    );

    const lease = acquireDataRootInstanceLock(
      root,
      makeRuntime({
        token: "new-owner",
        pid: 505,
        isProcessAlive: () => false,
      }),
    );

    expect(lease.reclaimedOwner?.token).toBe("dead-owner");
    expect(readCanonicalOwner(root).token).toBe("new-owner");
    expect(instanceSidecars(root, ".mgt-instance-stale-")).toEqual([]);
    lease.release();
  });

  it("blocks while a same-host live process owns the reclaim marker", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "dead-owner", pid: 404 }),
    );
    writeReclaimMarker(root, {
      schemaVersion: 1,
      token: "live-reclaimer",
      pid: 606,
      hostname: "HOST-A",
      startedAt: "2026-08-06T12:01:00.000Z",
    });

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({
          token: "new-owner",
          pid: 505,
          isProcessAlive: (pid) => pid === 606,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_ROOT_INSTANCE_LOCK_HELD",
        reason: "reclaim-in-progress",
      }),
    );
    expect(readCanonicalOwner(root).token).toBe("dead-owner");
  });

  it("restores a successor reclaim marker that changes before quarantine", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "dead-owner", pid: 404 }),
    );
    writeReclaimMarker(root, {
      schemaVersion: 1,
      token: "dead-reclaimer",
      pid: 606,
      hostname: "HOST-A",
      startedAt: "2026-08-06T12:01:00.000Z",
    });
    let markerReplaced = false;

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({
          token: "new-owner",
          pid: 505,
          isProcessAlive: (pid) => pid === 707,
        }),
        {
          beforeStaleReclaimMarkerQuarantine: () => {
            if (markerReplaced) {
              return;
            }
            markerReplaced = true;
            writeReclaimMarker(root, {
              schemaVersion: 1,
              token: "successor-reclaimer",
              pid: 707,
              hostname: "HOST-A",
              startedAt: "2026-08-06T12:02:00.000Z",
            });
          },
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_ROOT_INSTANCE_LOCK_HELD",
        reason: "reclaim-in-progress",
      }),
    );
    expect(readReclaimMarker(root).token).toBe("successor-reclaimer");
    expect(readCanonicalOwner(root).token).toBe("dead-owner");
  });

  it("fails closed for a foreign-host reclaim marker", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "dead-owner", pid: 404 }),
    );
    writeReclaimMarker(root, {
      schemaVersion: 1,
      token: "foreign-reclaimer",
      pid: 606,
      hostname: "OTHER-HOST",
      startedAt: "2026-08-06T12:01:00.000Z",
    });

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({ token: "new-owner", isProcessAlive: () => false }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_ROOT_INSTANCE_LOCK_HELD",
        reason: "foreign-host",
      }),
    );
    expect(readCanonicalOwner(root).token).toBe("dead-owner");
  });

  it("fails closed for invalid reclaim metadata", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "dead-owner", pid: 404 }),
    );
    writeReclaimMarker(root, "{not-json");

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({ token: "new-owner", isProcessAlive: () => false }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_ROOT_INSTANCE_LOCK_INVALID",
        reason: "reclaim-metadata-invalid",
      }),
    );
    expect(readCanonicalOwner(root).token).toBe("dead-owner");
  });

  it("removes a same-host dead-PID reclaim marker before reclaiming", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "dead-owner", pid: 404 }),
    );
    writeReclaimMarker(root, {
      schemaVersion: 1,
      token: "dead-reclaimer",
      pid: 606,
      hostname: "HOST-A",
      startedAt: "2026-08-06T12:01:00.000Z",
    });

    const lease = acquireDataRootInstanceLock(
      root,
      makeRuntime({
        token: "new-owner",
        pid: 505,
        isProcessAlive: () => false,
      }),
    );

    expect(lease.reclaimedOwner?.token).toBe("dead-owner");
    expect(readCanonicalOwner(root).token).toBe("new-owner");
    lease.release();
  });

  it("fails closed for a foreign hostname regardless of age", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, {
        token: "foreign-owner",
        hostname: "OTHER-HOST",
        startedAt: "2000-01-01T00:00:00.000Z",
      }),
    );

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({ token: "new-owner", isProcessAlive: () => false }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_ROOT_INSTANCE_LOCK_HELD",
        reason: "foreign-host",
      }),
    );
    expect(readCanonicalOwner(root).token).toBe("foreign-owner");
  });

  it.each([
    ["missing owner", (root: string) => mkdirSync(lockDirectory(root))],
    [
      "broken JSON",
      (root: string) => writeRawCanonicalOwner(root, "{not-json"),
    ],
    [
      "wrong schema version",
      (root: string) =>
        writeCanonicalOwner(root, makeOwner(root, { schemaVersion: 2 as 1 })),
    ],
    [
      "unexpected owner field",
      (root: string) =>
        writeRawCanonicalOwner(
          root,
          JSON.stringify({ ...makeOwner(root), unexpected: "value" }),
        ),
    ],
    [
      "invalid PID",
      (root: string) => writeCanonicalOwner(root, makeOwner(root, { pid: -1 })),
    ],
    [
      "mismatched data root",
      (root: string) =>
        writeCanonicalOwner(
          root,
          makeOwner(root, { dataRoot: join(root, "other") }),
        ),
    ],
    [
      "owner directory",
      (root: string) => {
        mkdirSync(lockDirectory(root));
        mkdirSync(
          join(lockDirectory(root), DATA_ROOT_INSTANCE_LOCK_OWNER_FILE),
        );
      },
    ],
    [
      "oversized owner",
      (root: string) => writeRawCanonicalOwner(root, "x".repeat(17 * 1024)),
    ],
    [
      "non-directory lock path",
      (root: string) => writeFileSync(lockDirectory(root), "not-a-directory"),
    ],
  ])("does not delete an invalid lock with %s", (_name, arrange) => {
    const root = makeRoot();
    arrange(root);

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({ token: "new-owner", isProcessAlive: () => false }),
      ),
    ).toThrow(DataRootInstanceLockInvalidError);
    expect(existsSync(lockDirectory(root))).toBe(true);
  });

  it("rejects a symbolic-link lock directory without following it", () => {
    const root = makeRoot();
    const target = join(root, "lock-target");
    mkdirSync(target);
    writeFileSync(
      join(target, DATA_ROOT_INSTANCE_LOCK_OWNER_FILE),
      JSON.stringify(makeOwner(root)),
    );
    symlinkSync(
      target,
      lockDirectory(root),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({ token: "new-owner", isProcessAlive: () => false }),
      ),
    ).toThrowError(
      expect.objectContaining({ reason: "lock-path-is-symbolic-link" }),
    );
    expect(existsSync(target)).toBe(true);
  });

  it("treats EPERM and unknown process probes as alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(isProcessAliveFailClosed(123)).toBe(true);

    vi.mocked(process.kill).mockImplementation(() => {
      throw new Error("unknown failure");
    });
    expect(isProcessAliveFailClosed(123)).toBe(true);

    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    expect(isProcessAliveFailClosed(123)).toBe(false);
  });

  it("does not delete a canonical lock after its owner token changes", () => {
    const root = makeRoot();
    const lease = acquireDataRootInstanceLock(
      root,
      makeRuntime({ token: "owner-a", pid: 101 }),
    );
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "owner-b", pid: 202 }),
      true,
    );

    expect(() => lease.release()).toThrow(DataRootInstanceLockLostError);
    expect(readCanonicalOwner(root).token).toBe("owner-b");
  });

  it("restores a successor that replaces the owner immediately before release rename", () => {
    const root = makeRoot();
    const lease = acquireDataRootInstanceLock(
      root,
      makeRuntime({ token: "owner-a", pid: 101 }),
      {
        afterReleaseOwnerRead: () => {
          writeCanonicalOwner(
            root,
            makeOwner(root, { token: "successor", pid: 303 }),
            true,
          );
        },
      },
    );

    expect(() => lease.release()).toThrow(DataRootInstanceLockLostError);
    expect(readCanonicalOwner(root).token).toBe("successor");
    expect(instanceSidecars(root, ".mgt-instance-release-")).toEqual([]);
  });

  it("never removes a successor published after release quarantine rename", () => {
    const root = makeRoot();
    const lease = acquireDataRootInstanceLock(
      root,
      makeRuntime({ token: "owner-a", pid: 101 }),
      {
        afterReleaseRename: () => {
          writeCanonicalOwner(
            root,
            makeOwner(root, { token: "successor", pid: 303 }),
          );
        },
      },
    );

    lease.release();
    expect(readCanonicalOwner(root).token).toBe("successor");
  });

  it("rechecks a stale owner after obtaining the reclaim marker", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "dead-owner", pid: 404 }),
    );
    let ownerChanged = false;

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({
          token: "new-owner",
          pid: 505,
          isProcessAlive: (pid) => pid === 606,
        }),
        {
          afterInitialOwnerRead: () => {
            if (!ownerChanged) {
              ownerChanged = true;
              writeCanonicalOwner(
                root,
                makeOwner(root, { token: "live-owner", pid: 606 }),
                true,
              );
            }
          },
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_ROOT_INSTANCE_LOCK_HELD",
        reason: "live-process",
      }),
    );
    expect(readCanonicalOwner(root).token).toBe("live-owner");
  });

  it("does not disturb a contender that publishes while stale quarantine is open", () => {
    const root = makeRoot();
    writeCanonicalOwner(
      root,
      makeOwner(root, { token: "dead-owner", pid: 404 }),
    );

    expect(() =>
      acquireDataRootInstanceLock(
        root,
        makeRuntime({
          token: "new-owner",
          pid: 505,
          isProcessAlive: (pid) => pid === 606,
        }),
        {
          afterReclaimRename: () => {
            writeCanonicalOwner(
              root,
              makeOwner(root, { token: "contender", pid: 606 }),
            );
          },
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_ROOT_INSTANCE_LOCK_HELD",
        reason: "live-process",
      }),
    );
    expect(readCanonicalOwner(root).token).toBe("contender");
    expect(instanceSidecars(root, ".mgt-instance-stale-")).toEqual([]);
  });

  it("reports typed held errors", () => {
    const root = makeRoot();
    writeCanonicalOwner(root, makeOwner(root));

    try {
      acquireDataRootInstanceLock(
        root,
        makeRuntime({ token: "new-owner", isProcessAlive: () => true }),
      );
      throw new Error("Expected acquisition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DataRootInstanceLockHeldError);
    }
  });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mgt-instance-lock-"));
  roots.push(root);
  return root;
}

function makeRuntime(
  overrides: Omit<
    Partial<DataRootInstanceLockRuntime>,
    "createToken" | "processId"
  > & { token?: string; pid?: number } = {},
): DataRootInstanceLockRuntime {
  const { token = "owner-token", pid = 101, ...runtimeOverrides } = overrides;
  return {
    now: () => new Date("2026-08-06T12:34:56.789Z"),
    createToken: () => token,
    getHostname: () => "HOST-A",
    processId: pid,
    executablePath: "C:\\Program Files\\Carrot Manga Translator\\app.exe",
    appVersion: "1.10.1-test",
    isProcessAlive: () => true,
    ...runtimeOverrides,
  };
}

function makeOwner(
  root: string,
  overrides: Partial<DataRootInstanceLockOwner> = {},
): DataRootInstanceLockOwner {
  return {
    schemaVersion: 1,
    token: "existing-owner",
    pid: 404,
    hostname: "HOST-A",
    startedAt: "2026-08-06T12:00:00.000Z",
    executablePath: "C:\\Program Files\\Carrot Manga Translator\\app.exe",
    appVersion: "1.10.1-test",
    dataRoot: canonicalizeDataRoot(root),
    ...overrides,
  };
}

function lockDirectory(root: string): string {
  return join(canonicalizeDataRoot(root), DATA_ROOT_INSTANCE_LOCK_DIRECTORY);
}

function writeCanonicalOwner(
  root: string,
  owner: DataRootInstanceLockOwner,
  replace = false,
): void {
  const directory = lockDirectory(root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, DATA_ROOT_INSTANCE_LOCK_OWNER_FILE),
    `${JSON.stringify(owner, null, 2)}\n`,
    replace ? { encoding: "utf8" } : { encoding: "utf8", flag: "wx" },
  );
}

function writeRawCanonicalOwner(root: string, value: string): void {
  const directory = lockDirectory(root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, DATA_ROOT_INSTANCE_LOCK_OWNER_FILE), value);
}

function writeReclaimMarker(root: string, value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(join(lockDirectory(root), "reclaim.json"), serialized, "utf8");
}

function readReclaimMarker(root: string): { token: string } {
  return JSON.parse(
    readFileSync(join(lockDirectory(root), "reclaim.json"), "utf8"),
  ) as { token: string };
}

function readCanonicalOwner(root: string): DataRootInstanceLockOwner {
  return JSON.parse(
    readFileSync(
      join(lockDirectory(root), DATA_ROOT_INSTANCE_LOCK_OWNER_FILE),
      "utf8",
    ),
  ) as DataRootInstanceLockOwner;
}

function instanceSidecars(root: string, prefix: string): string[] {
  return readdirSync(realpathSync.native(root)).filter((entry) =>
    entry.startsWith(prefix),
  );
}
