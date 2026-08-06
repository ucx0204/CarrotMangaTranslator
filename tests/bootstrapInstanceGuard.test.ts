import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  establishBootstrapInstanceGuard,
  type BootstrapInstanceGuardRuntime,
} from "../src/main/bootstrapInstanceGuard";
import type { DataRootInstanceLockLease } from "../src/main/dataRootInstanceLock";

const repoRoot = join(__dirname, "..");

describe("bootstrap instance guard", () => {
  it("requests the Electron lock before acquiring and installing the data-root lease", () => {
    const events: string[] = [];
    const lease = makeLease(events);
    const runtime = makeRuntime(events, {
      acquireDataRootLock: vi.fn(() => {
        events.push("acquire-data-root-lock");
        return lease;
      }),
    });

    const result = establishBootstrapInstanceGuard("C:\\data", runtime);

    expect(result).toEqual({ status: "primary", dataRoot: "C:\\data" });
    expect(events).toEqual([
      "canonicalize-data-root",
      "request-electron-lock",
      "acquire-data-root-lock",
      "install-data-root-lease",
    ]);
    expect(runtime.requestSingleInstanceLock).toHaveBeenCalledWith({
      schemaVersion: 1,
      dataRoot: "C:\\data",
    });
  });

  it("quits a secondary without acquiring the data-root lock or reporting failure", () => {
    const events: string[] = [];
    const runtime = makeRuntime(events, {
      requestSingleInstanceLock: vi.fn(() => {
        events.push("request-electron-lock");
        return false;
      }),
    });

    expect(establishBootstrapInstanceGuard("C:\\data", runtime)).toEqual({
      status: "secondary",
    });
    expect(events).toEqual([
      "canonicalize-data-root",
      "request-electron-lock",
      "quit-secondary",
    ]);
    expect(runtime.acquireDataRootLock).not.toHaveBeenCalled();
    expect(runtime.installDataRootLockLease).not.toHaveBeenCalled();
    expect(runtime.reportStartupFailure).not.toHaveBeenCalled();
    expect(runtime.releaseSingleInstanceLock).not.toHaveBeenCalled();
  });

  it("releases the Electron lock, reports, and exits with code 2 when data locking fails", () => {
    const events: string[] = [];
    const failure = new Error("data lock failed");
    const runtime = makeRuntime(events, {
      acquireDataRootLock: vi.fn(() => {
        events.push("acquire-data-root-lock");
        throw failure;
      }),
    });

    expect(establishBootstrapInstanceGuard("C:\\data", runtime)).toEqual({
      status: "failed",
      error: failure,
    });
    expect(events).toEqual([
      "canonicalize-data-root",
      "request-electron-lock",
      "acquire-data-root-lock",
      "release-electron-lock",
      "report-startup-failure",
      "exit-startup-failure:2",
    ]);
  });

  it("releases an acquired lease when lease installation fails", () => {
    const events: string[] = [];
    const lease = makeLease(events);
    const failure = new Error("install failed");
    const runtime = makeRuntime(events, {
      acquireDataRootLock: vi.fn(() => {
        events.push("acquire-data-root-lock");
        return lease;
      }),
      installDataRootLockLease: vi.fn(() => {
        events.push("install-data-root-lease");
        throw failure;
      }),
    });

    expect(establishBootstrapInstanceGuard("C:\\data", runtime)).toEqual({
      status: "failed",
      error: failure,
    });
    expect(events).toEqual([
      "canonicalize-data-root",
      "request-electron-lock",
      "acquire-data-root-lock",
      "install-data-root-lease",
      "release-data-root-lock",
      "release-electron-lock",
      "report-startup-failure",
      "exit-startup-failure:2",
    ]);
  });

  it("fails before requesting the Electron lock when dataRoot is missing", () => {
    const events: string[] = [];
    const runtime = makeRuntime(events);

    const result = establishBootstrapInstanceGuard(null, runtime);

    expect(result.status).toBe("failed");
    expect(events).toEqual([
      "report-startup-failure",
      "exit-startup-failure:2",
    ]);
    expect(runtime.canonicalizeDataRoot).not.toHaveBeenCalled();
    expect(runtime.requestSingleInstanceLock).not.toHaveBeenCalled();
  });
});

describe("instance guard source invariants", () => {
  it("guards bootstrap before GPU setup, shared logging, and the main import", () => {
    const bootstrapSource = readFileSync(
      join(repoRoot, "src", "main", "bootstrap.ts"),
      "utf8",
    );
    const storage = bootstrapSource.indexOf(
      "configureDevelopmentElectronStorage(dataRoot)",
    );
    const guard = bootstrapSource.indexOf("establishBootstrapInstanceGuard(");
    const graphics = bootstrapSource.indexOf(
      "configureGraphicsGpu(guard.dataRoot)",
    );
    const bootstrapLog = bootstrapSource.indexOf(
      'writeBootstrapLog("bootstrap:start"',
    );
    const mainImport = bootstrapSource.indexOf('require("./index")');

    expect(storage).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(storage);
    expect(graphics).toBeGreaterThan(guard);
    expect(bootstrapLog).toBeGreaterThan(graphics);
    expect(mainImport).toBeGreaterThan(bootstrapLog);
  });

  it("asserts the bootstrap lease before writable main initialization", () => {
    const mainSource = readFileSync(
      join(repoRoot, "src", "main", "index.ts"),
      "utf8",
    );
    expect(mainSource.indexOf("assertDataRootInstanceLockHeld")).toBeLessThan(
      mainSource.indexOf("ensureWritableAppDirectories()"),
    );
    expect(mainSource).not.toContain("releaseSingleInstanceLock");
  });

  it("releases the data-root lease after runtime cleanup and immediately before quit", () => {
    const mainSource = readFileSync(
      join(repoRoot, "src", "main", "index.ts"),
      "utf8",
    );
    const cleanupStart = mainSource.indexOf(
      "async function finishAppQuitCleanup()",
    );
    const cleanupEnd = mainSource.indexOf(
      "function openMainWindow()",
      cleanupStart,
    );
    const cleanupSource = mainSource.slice(cleanupStart, cleanupEnd);
    const dispose = cleanupSource.indexOf("disposeCachedInpaintingEngines");
    const revisionRelease = cleanupSource.indexOf(
      "inpaintingRevisionStore.releaseAll()",
    );
    const dataRootRelease = cleanupSource.indexOf(
      "releaseDataRootInstanceLockLease()",
    );
    const quit = cleanupSource.lastIndexOf("app.quit()");

    expect(dispose).toBeGreaterThanOrEqual(0);
    expect(revisionRelease).toBeGreaterThan(dispose);
    expect(dataRootRelease).toBeGreaterThan(revisionRelease);
    expect(quit).toBeGreaterThan(dataRootRelease);
  });

  it("registers early second-instance handling with pending startup focus", () => {
    const mainSource = readFileSync(
      join(repoRoot, "src", "main", "index.ts"),
      "utf8",
    );
    const listener = mainSource.indexOf('"second-instance"');
    const ready = mainSource.indexOf("app\n  .whenReady()");
    const pendingSet = mainSource.indexOf("secondInstanceFocusPending = true");
    const startupCompleted = mainSource.indexOf("mainStartupCompleted = true");
    const pendingReplay = mainSource.indexOf(
      "if (secondInstanceFocusPending)",
      startupCompleted,
    );

    expect(listener).toBeGreaterThanOrEqual(0);
    expect(listener).toBeLessThan(ready);
    expect(pendingSet).toBeGreaterThan(listener);
    expect(pendingReplay).toBeGreaterThan(startupCompleted);
  });

  it("keeps app.exit out of the error-report restart path", () => {
    const errorReportSource = readFileSync(
      join(repoRoot, "src", "main", "ipc", "errorReportIpc.ts"),
      "utf8",
    );
    expect(errorReportSource).not.toContain("app.exit(");
    expect(errorReportSource).toContain("app.quit()");
  });

  it("releases the data-root lease before the mac package smoke app.exit path", () => {
    const smokeSource = readFileSync(
      join(repoRoot, "src", "main", "macPackageSmoke.ts"),
      "utf8",
    );
    const helperStart = smokeSource.indexOf(
      "function exitMacPackageSmokeProcess",
    );
    const helperSource = smokeSource.slice(helperStart);
    expect(
      helperSource.indexOf("releaseDataRootInstanceLockLease"),
    ).toBeLessThan(helperSource.indexOf("app.exit(exitCode)"));
  });

  it("keeps the packaged entry pointed at bootstrap", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { main: string };
    expect(packageJson.main).toBe("./out/main/bootstrap.js");
  });
});

function makeRuntime(
  events: string[],
  overrides: Partial<BootstrapInstanceGuardRuntime> = {},
): BootstrapInstanceGuardRuntime {
  return {
    canonicalizeDataRoot: vi.fn((dataRoot) => {
      events.push("canonicalize-data-root");
      return dataRoot;
    }),
    requestSingleInstanceLock: vi.fn(() => {
      events.push("request-electron-lock");
      return true;
    }),
    releaseSingleInstanceLock: vi.fn(() => {
      events.push("release-electron-lock");
    }),
    quitSecondaryInstance: vi.fn(() => {
      events.push("quit-secondary");
    }),
    exitStartupFailure: vi.fn((code) => {
      events.push(`exit-startup-failure:${code}`);
    }),
    reportStartupFailure: vi.fn(() => {
      events.push("report-startup-failure");
    }),
    acquireDataRootLock: vi.fn(() => {
      events.push("acquire-data-root-lock");
      return makeLease(events);
    }),
    installDataRootLockLease: vi.fn(() => {
      events.push("install-data-root-lease");
    }),
    ...overrides,
  };
}

function makeLease(events: string[]): DataRootInstanceLockLease {
  return {
    dataRoot: "C:\\data",
    lockDirectory: "C:\\data\\.mgt-instance-lock",
    owner: {
      schemaVersion: 1,
      token: "owner-token",
      pid: 123,
      hostname: "HOST-A",
      startedAt: "2026-08-06T12:00:00.000Z",
      executablePath: "C:\\app.exe",
      appVersion: "1.10.1-test",
      dataRoot: "C:\\data",
    },
    release: vi.fn(() => {
      events.push("release-data-root-lock");
    }),
  };
}
