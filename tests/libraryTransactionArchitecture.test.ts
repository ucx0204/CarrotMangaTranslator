import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("library transaction architecture", () => {
  it("runs transaction and legacy recovery before IPC/window publication and before deferred orphan cleanup", async () => {
    const source = await readFile("src/main/index.ts", "utf8");
    const instanceLock = source.indexOf(
      "assertDataRootInstanceLockHeld(resolvedAppPaths.dataRoot)",
    );
    const recoverTransactions = source.indexOf(
      "await recoverLibraryTransactions()",
    );
    const recoverLegacyTrash = source.indexOf(
      "await recoverLegacyShareImportTrash()",
    );
    const registerIpc = source.indexOf("registerIpc({");
    const openMainWindow = source.indexOf("openMainWindow();", registerIpc);
    const scheduleMaintenance = source.indexOf(
      "cancelStartupMaintenance = scheduleStartupMaintenance",
      openMainWindow,
    );

    expect(instanceLock).toBeGreaterThanOrEqual(0);
    expect(recoverTransactions).toBeGreaterThan(instanceLock);
    expect(recoverLegacyTrash).toBeGreaterThan(recoverTransactions);
    expect(registerIpc).toBeGreaterThan(recoverLegacyTrash);
    expect(openMainWindow).toBeGreaterThan(registerIpc);
    expect(scheduleMaintenance).toBeGreaterThan(openMainWindow);
  });

  it("uses the active-to-committed directory rename as the commit point and never safeCleanup for rollback", async () => {
    const source = await readFile(
      "src/main/libraryStore/libraryTransaction.ts",
      "utf8",
    );
    expect(source).toContain('".transactions",\n      "committed"');
    expect(source).toContain("await durableRename(state.root, committedRoot)");
    expect(source).not.toContain("safeCleanup");
  });

  it("keeps new share imports off the legacy .trash production path", async () => {
    const source = await readFile(
      "src/main/libraryStore/shareImportExistingWorkflow.ts",
      "utf8",
    );
    expect(source).toContain("transaction.retireDirectory");
    expect(source).not.toContain("moveOmittedExistingChaptersToTrash");
    expect(source).not.toContain("discardTrashedChapterDirectories");
    expect(source).not.toContain("safeCleanup");
  });

  it("closes library mutation intake synchronously before bounded quit cleanup", async () => {
    const source = await readFile("src/main/index.ts", "utf8");
    const activityClose = source.indexOf(
      "appActivityGate.closeToNewActivities()",
    );
    const mutationClose = source.indexOf(
      "libraryMutationCoordinator.closeToNewMutations()",
      activityClose,
    );
    const beginQuit = source.indexOf("beginBoundedAppQuit({", mutationClose);
    expect(activityClose).toBeGreaterThanOrEqual(0);
    expect(mutationClose).toBeGreaterThan(activityClose);
    expect(beginQuit).toBeGreaterThan(mutationClose);
  });
});
