/* eslint-disable max-depth, max-lines-per-function -- startup transaction phase recovery and fail-closed cleanup ordering stay co-located for auditability */
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getLibraryRoot } from "./libraryPaths";
import { libraryMutationCoordinator } from "./libraryMutationCoordinator";
import { logLibraryWarning } from "./libraryLogger";
import { withLibraryPublicationWrite } from "./libraryPublicationLock";
import {
  cleanupCommittedTransactionDirectory,
  isLibraryTransactionDirectoryName,
  readAndValidateTransactionJournal,
  rollbackLibraryTransactionDirectory,
} from "./libraryTransaction";
import {
  assertDirectoryWithoutSymlink,
  pathState,
  removeTree,
} from "./libraryTransactionStorage";

export type LibraryTransactionRecoveryResult = {
  creatingRemoved: number;
  activeRolledBack: number;
  committedCleaned: number;
  committedCleanupWarnings: number;
};

export async function recoverLibraryTransactions(): Promise<LibraryTransactionRecoveryResult> {
  const libraryRoot = resolve(getLibraryRoot());
  const roots = await ensureRecoveryRoots(libraryRoot);
  const result: LibraryTransactionRecoveryResult = {
    creatingRemoved: 0,
    activeRolledBack: 0,
    committedCleaned: 0,
    committedCleanupWarnings: 0,
  };

  try {
    for (const entry of await listTransactionDirectories(roots.creating)) {
      const transactionRoot = join(roots.creating, entry);
      await assertDirectoryWithoutSymlink(transactionRoot);
      await removeTree(transactionRoot);
      result.creatingRemoved += 1;
    }

    for (const entry of await listTransactionDirectories(roots.active)) {
      const transactionRoot = join(roots.active, entry);
      await assertDirectoryWithoutSymlink(transactionRoot);
      if (!isLibraryTransactionDirectoryName(entry)) {
        throw new Error(
          `active transaction directory 이름이 올바르지 않습니다: ${transactionRoot}`,
        );
      }
      const journal = await readAndValidateTransactionJournal(
        transactionRoot,
        entry,
      );
      if (!journal.sealed) {
        await removeTree(transactionRoot);
        result.activeRolledBack += 1;
        continue;
      }
      await withLibraryPublicationWrite(() =>
        rollbackLibraryTransactionDirectory({
          libraryRoot,
          transactionRoot,
          journal,
          removeAfterSuccess: true,
        }),
      );
      result.activeRolledBack += 1;
    }

    for (const entry of await listTransactionDirectories(roots.committed)) {
      const transactionRoot = join(roots.committed, entry);
      try {
        await assertDirectoryWithoutSymlink(transactionRoot);
        if (!isLibraryTransactionDirectoryName(entry)) {
          throw new Error(
            `committed transaction directory 이름이 올바르지 않습니다: ${transactionRoot}`,
          );
        }
        const journal = await readAndValidateTransactionJournal(
          transactionRoot,
          entry,
        );
        if (!journal.sealed) {
          throw new Error(
            `committed transaction journal이 sealed 상태가 아닙니다: ${transactionRoot}`,
          );
        }
        await cleanupCommittedTransactionDirectory({
          libraryRoot,
          transactionRoot,
          journal,
        });
        result.committedCleaned += 1;
      } catch (error) {
        result.committedCleanupWarnings += 1;
        logLibraryWarning(
          "Committed library transaction cleanup failed during startup; will retry",
          { transactionRoot, error },
        );
      }
    }
  } catch (error) {
    libraryMutationCoordinator.markRecoveryRequired(error);
    throw new Error(
      `보관함 transaction 복구에 실패했습니다: ${formatRecoveryError(error)}`,
      { cause: error },
    );
  }

  libraryMutationCoordinator.clearRecoveryRequiredAfterStartup();
  return result;
}

async function ensureRecoveryRoots(libraryRoot: string): Promise<{
  creating: string;
  active: string;
  committed: string;
}> {
  await ensureSafeDirectory(libraryRoot);
  const transactions = join(libraryRoot, ".transactions");
  await ensureSafeDirectory(transactions);
  const creating = join(transactions, "creating");
  const active = join(transactions, "active");
  const committed = join(transactions, "committed");
  await ensureSafeDirectory(creating);
  await ensureSafeDirectory(active);
  await ensureSafeDirectory(committed);
  return { creating, active, committed };
}

async function ensureSafeDirectory(path: string): Promise<void> {
  const state = await pathState(path);
  if (state === "missing") {
    await mkdir(path);
  } else if (state !== "directory") {
    throw new Error(
      `transaction recovery path가 directory가 아닙니다: ${path}`,
    );
  }
  await assertDirectoryWithoutSymlink(path);
}

async function listTransactionDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          `transaction root에 안전하지 않은 entry가 있습니다: ${join(root, entry.name)}`,
        );
      }
      return entry.name;
    })
    .sort();
}

function formatRecoveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
