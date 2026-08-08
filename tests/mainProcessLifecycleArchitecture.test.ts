import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexSource = readSource("src/main/index.ts");
const fatalSource = readSource("src/main/fatalMainProcessIncident.ts");
const closeCleanupSource = readSource("src/main/mainWindowCloseCleanup.ts");
const sessionSource = readSource("src/main/mainWindowSessionLifecycle.ts");

describe("main-process lifecycle architecture", () => {
  it("routes both process-level fatal events through the fatal handler", () => {
    expect(indexSource).toMatch(
      /process\.on\("uncaughtException"[\s\S]*?handleFatalMainProcessIncident\(/,
    );
    expect(indexSource).toMatch(
      /process\.on\("unhandledRejection"[\s\S]*?handleFatalMainProcessIncident\(/,
    );
    expect(indexSource).toContain("FatalMainProcessIncidentCoordinator");
  });

  it("delegates closed-window cleanup without direct runtime disposal", () => {
    const closedHandlerStart = indexSource.indexOf('mainWindow.on("closed"');
    const nextFunction = indexSource.indexOf(
      "function requestMainWindowOpen",
      closedHandlerStart,
    );
    const closedHandler = indexSource.slice(closedHandlerStart, nextFunction);

    expect(closedHandlerStart).toBeGreaterThanOrEqual(0);
    expect(closedHandler).toContain("handleMainWindowClosed()");
    expect(closedHandler).not.toContain("disposeCachedInpaintingEngines");
    expect(closedHandler).not.toContain("disposeTranslationRuntimeResources");
  });

  it("uses fail-closed exit semantics in the fatal coordinator", () => {
    expect(fatalSource).toContain("FATAL_MAIN_PROCESS_EXIT_CODE = 1");
    expect(fatalSource).toContain("secondary-fatal-incident");
    expect(fatalSource).toContain("runtime.forceExit");
    expect(fatalSource).toContain("runtime.emergencyExit");
    expect(fatalSource).not.toMatch(/app\.quit|gracefulQuit/);
  });

  it("guards startup before IPC and main-window publication", () => {
    const recoveryIndex = indexSource.indexOf("recoverLegacyShareImportTrash");
    const guardIndex = indexSource.indexOf(
      "if (fatalCoordinator.isHandling)",
      recoveryIndex,
    );
    const ipcIndex = indexSource.indexOf("registerIpc({", recoveryIndex);
    const windowIndex = indexSource.indexOf("openMainWindowNow();", ipcIndex);

    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThan(recoveryIndex);
    expect(ipcIndex).toBeGreaterThan(guardIndex);
    expect(windowIndex).toBeGreaterThan(ipcIndex);
  });

  it("coalesces app-quit and fatal work behind one terminal promise", () => {
    expect(indexSource).toContain(
      "let terminalCleanupPromise: Promise<void> | null = null",
    );
    expect(indexSource).toContain("terminalCleanupPromise ??=");
    expect(indexSource).toContain(
      'getOrStartTerminalCleanup("app-quit", updateProgress)',
    );
    expect(indexSource).toContain(
      'getOrStartTerminalCleanup("fatal-incident")',
    );
    expect(indexSource).toContain(
      "await mainWindowSessionLifecycle.waitForCleanup()",
    );
  });

  it("never releases the data-root lock from abnormal lifecycle modules", () => {
    for (const source of [
      indexSource,
      fatalSource,
      closeCleanupSource,
      sessionSource,
    ]) {
      expect(source).not.toContain("releaseDataRootInstanceLockLease");
    }
  });
});

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}
