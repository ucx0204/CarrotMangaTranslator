/* eslint-disable max-lines -- durable transaction commit, rollback, and recovery step semantics stay co-located for auditability */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { getLibraryRoot } from "./libraryPaths";
import { libraryMutationCoordinator } from "./libraryMutationCoordinator";
import { logLibraryWarning } from "./libraryLogger";
import { withLibraryPublicationWrite } from "./libraryPublicationLock";
import {
  assertNoTargetOverlap,
  resolveLibraryRelativePath,
  resolveTransactionRelativePath,
  toLibraryRelativePath,
  validateCanonicalRelativePath,
  validateLibraryTransactionJournalPaths,
} from "./libraryTransactionPaths";
import {
  LIBRARY_TRANSACTION_SCHEMA_VERSION,
  LibraryTransactionJournalSchema,
  MAX_LIBRARY_TRANSACTION_JOURNAL_BYTES,
  type LibraryTransactionJournal,
  type LibraryTransactionOwnerMarker,
  type LibraryTransactionStep,
  type PublishDirectoryStep,
  type ReplaceFileStep,
  type RetirePathStep,
} from "./libraryTransactionSchema";
import {
  assertDirectoryWithoutSymlink,
  assertPathWithinRootWithoutSymlinks,
  copyDurableBackup,
  durableRemoveFile,
  durableRename,
  pathState,
  readBoundedJsonFile,
  removeTree,
  restoreBackupAtomically,
  sha256Bytes,
  sha256File,
  syncDirectory,
  syncDirectoryTree,
  writeDurableFile,
  writeDurableJsonFile,
} from "./libraryTransactionStorage";

const TRANSACTION_OWNER_MARKER = ".mgt-transaction-owner.json";
const transactionContext = new AsyncLocalStorage<boolean>();

export type LibraryTransaction = {
  stageJsonReplacement(targetPath: string, payload: unknown): Promise<void>;
  createPublishedDirectory(finalDirectory: string): Promise<{
    stagingDirectory: string;
    finalDirectory: string;
  }>;
  retireFile(
    targetPath: string,
    options?: { required?: boolean },
  ): Promise<void>;
  retireDirectory(
    targetPath: string,
    options?: { required?: boolean },
  ): Promise<void>;
};

export type LibraryTransactionCrashPoint =
  | "after-initial-journal"
  | "after-seal"
  | "after-publish-step"
  | "after-replace-step"
  | "after-retire-step"
  | "before-commit-point"
  | "after-commit-point"
  | "owner-marker-cleanup"
  | "committed-dir-cleanup";

export class SimulatedLibraryTransactionCrash extends Error {
  constructor(public readonly point: LibraryTransactionCrashPoint) {
    super(`Simulated library transaction crash: ${point}`);
    this.name = "SimulatedLibraryTransactionCrash";
  }
}

let crashInjector:
  | ((point: LibraryTransactionCrashPoint) => void | Promise<void>)
  | null = null;

export function setLibraryTransactionCrashInjectorForTests(
  injector:
    | ((point: LibraryTransactionCrashPoint) => void | Promise<void>)
    | null,
): () => void {
  const previous = crashInjector;
  crashInjector = injector;
  return () => {
    crashInjector = previous;
  };
}

export async function runLibraryTransaction<T>(
  kind: string,
  operation: (transaction: LibraryTransaction) => Promise<T>,
): Promise<T> {
  if (transactionContext.getStore()) {
    throw new Error("중첩된 보관함 transaction은 허용되지 않습니다.");
  }
  if (!kind || kind.length > 100) {
    throw new Error("보관함 transaction kind가 올바르지 않습니다.");
  }

  return transactionContext.run(true, async () => {
    const state = await beginLibraryTransaction(kind);
    let outcome: { ready: false } | { ready: true; value: T } = {
      ready: false,
    };
    try {
      const value = await operation(state.api);
      outcome = { ready: true, value };
      await sealLibraryTransaction(state);
      await commitLibraryTransaction(state);
      return value;
    } catch (operationError) {
      if (operationError instanceof SimulatedLibraryTransactionCrash) {
        throw operationError;
      }
      if (state.committed) {
        // The commit point is authoritative. Production cleanup paths after it
        // must not throw, but keep this guard fail-safe if that invariant regresses.
        logLibraryWarning(
          "Ignoring post-commit library transaction error; final state is authoritative",
          { transactionId: state.journal.id, error: operationError },
        );
        if (!outcome.ready) {
          throw operationError;
        }
        return outcome.value;
      }
      try {
        await rollbackTransactionState(state);
      } catch (rollbackError) {
        libraryMutationCoordinator.markRecoveryRequired(rollbackError);
        throwRollbackFailure(operationError, rollbackError);
      }
      throw operationError;
    }
  });
}

function throwRollbackFailure(
  operationError: unknown,
  rollbackError: unknown,
): never {
  throw new AggregateError(
    [operationError, rollbackError],
    "보관함 작업과 transaction rollback이 모두 실패했습니다.",
    { cause: operationError },
  );
}

type TransactionState = {
  libraryRoot: string;
  root: string;
  phase: "creating" | "active" | "committed";
  journal: LibraryTransactionJournal;
  committed: boolean;
  api: LibraryTransaction;
};

async function beginLibraryTransaction(
  kind: string,
): Promise<TransactionState> {
  const libraryRoot = resolve(getLibraryRoot());
  await ensureTransactionRoots(libraryRoot);
  const id = randomUUID();
  const creatingRoot = join(libraryRoot, ".transactions", "creating", id);
  const activeRoot = join(libraryRoot, ".transactions", "active", id);
  await mkdir(creatingRoot);
  await assertDirectoryWithoutSymlink(creatingRoot);

  const journal: LibraryTransactionJournal = {
    schemaVersion: LIBRARY_TRANSACTION_SCHEMA_VERSION,
    id,
    kind,
    createdAt: new Date().toISOString(),
    sealed: false,
    steps: [],
  };
  await writeJournal(creatingRoot, journal);
  await syncDirectory(creatingRoot);
  await maybeInjectCrash("after-initial-journal");
  await durableRename(creatingRoot, activeRoot);

  const state = {} as TransactionState;
  state.libraryRoot = libraryRoot;
  state.root = activeRoot;
  state.phase = "active";
  state.journal = journal;
  state.committed = false;
  state.api = createTransactionApi(state);
  return state;
}

async function ensureTransactionRoots(libraryRoot: string): Promise<void> {
  await ensureSafeDirectory(libraryRoot);
  const transactionsRoot = join(libraryRoot, ".transactions");
  await ensureSafeDirectory(transactionsRoot);
  await ensureSafeDirectory(join(transactionsRoot, "creating"));
  await ensureSafeDirectory(join(transactionsRoot, "active"));
  await ensureSafeDirectory(join(transactionsRoot, "committed"));
}

async function ensureSafeDirectory(path: string): Promise<void> {
  const state = await pathState(path);
  if (state === "missing") {
    await mkdir(path);
  } else if (state !== "directory") {
    throw new Error(
      `transaction directory가 안전한 directory가 아닙니다: ${path}`,
    );
  }
  await assertDirectoryWithoutSymlink(path);
}

function createTransactionApi(state: TransactionState): LibraryTransaction {
  return {
    stageJsonReplacement: (targetPath, payload) =>
      stageJsonReplacement(state, targetPath, payload),
    createPublishedDirectory: (finalDirectory) =>
      createPublishedDirectory(state, finalDirectory),
    retireFile: (targetPath, options) =>
      stageRetirePath(state, targetPath, "file", options?.required ?? true),
    retireDirectory: (targetPath, options) =>
      stageRetirePath(
        state,
        targetPath,
        "directory",
        options?.required ?? true,
      ),
  };
}

async function stageJsonReplacement(
  state: TransactionState,
  targetPath: string,
  payload: unknown,
): Promise<void> {
  assertStagingOpen(state);
  const target = toLibraryRelativePath(state.libraryRoot, targetPath);
  assertNoTargetOverlap(
    state.journal.steps.map((step) => step.target),
    target,
  );
  const absoluteTarget = resolveLibraryRelativePath(state.libraryRoot, target);
  await assertPathWithinRootWithoutSymlinks(state.libraryRoot, absoluteTarget, {
    allowMissingTarget: true,
  });

  let serialized: string;
  try {
    const value = JSON.stringify(payload, null, 2);
    if (value === undefined) {
      throw new Error("JSON payload is undefined.");
    }
    serialized = `${value}\n`;
  } catch (error) {
    throw new Error("transaction JSON payload를 직렬화하지 못했습니다.", {
      cause: error,
    });
  }
  const bytes = Buffer.from(serialized, "utf8");
  const sequence = formatStepSequence(state.journal.steps.length + 1);
  const staged = `staged/${sequence}.json`;
  const stagedPath = resolveTransactionRelativePath(
    state.root,
    staged,
    "staged",
  );
  await writeDurableFile(stagedPath, bytes);
  const stagedSha256 = sha256Bytes(bytes);

  const targetState = await pathState(absoluteTarget);
  let step: ReplaceFileStep;
  if (targetState === "missing") {
    step = {
      kind: "replace-file",
      target,
      staged,
      stagedSha256,
      hadOriginal: false,
    };
  } else {
    if (targetState !== "file") {
      throw new Error(
        `transaction replace 대상이 regular file이 아닙니다: ${absoluteTarget}`,
      );
    }
    const backup = `backups/${sequence}.json`;
    const backupPath = resolveTransactionRelativePath(
      state.root,
      backup,
      "backups",
    );
    const backupSha256 = await copyDurableBackup(absoluteTarget, backupPath);
    step = {
      kind: "replace-file",
      target,
      staged,
      stagedSha256,
      hadOriginal: true,
      backup,
      backupSha256,
    };
  }
  await appendJournalStep(state, step);
}

async function createPublishedDirectory(
  state: TransactionState,
  finalDirectory: string,
): Promise<{ stagingDirectory: string; finalDirectory: string }> {
  assertStagingOpen(state);
  const target = toLibraryRelativePath(state.libraryRoot, finalDirectory);
  assertNoTargetOverlap(
    state.journal.steps.map((step) => step.target),
    target,
  );
  const resolvedFinal = resolveLibraryRelativePath(state.libraryRoot, target);
  await assertPathWithinRootWithoutSymlinks(state.libraryRoot, resolvedFinal, {
    allowMissingTarget: true,
  });
  if ((await pathState(resolvedFinal)) !== "missing") {
    throw new Error(`publish target이 이미 존재합니다: ${resolvedFinal}`);
  }

  const sequence = formatStepSequence(state.journal.steps.length + 1);
  const staged = `staged/${sequence}`;
  const stagingDirectory = resolveTransactionRelativePath(
    state.root,
    staged,
    "staged",
  );
  await mkdir(dirname(stagingDirectory), { recursive: true });
  await mkdir(stagingDirectory, { recursive: false });
  await assertDirectoryWithoutSymlink(stagingDirectory);
  const ownerMarker = `${staged}/${TRANSACTION_OWNER_MARKER}`;
  const ownerMarkerPath = resolveTransactionRelativePath(
    state.root,
    ownerMarker,
    "staged",
  );
  const marker: LibraryTransactionOwnerMarker = {
    schemaVersion: 1,
    transactionId: state.journal.id,
    target,
  };
  await writeDurableJsonFile(ownerMarkerPath, marker);
  await syncDirectory(stagingDirectory);

  const step: PublishDirectoryStep = {
    kind: "publish-directory",
    target,
    staged,
    ownerMarker,
  };
  await appendJournalStep(state, step);
  return { stagingDirectory, finalDirectory: resolvedFinal };
}

async function stageRetirePath(
  state: TransactionState,
  targetPath: string,
  pathType: "file" | "directory",
  required: boolean,
): Promise<void> {
  assertStagingOpen(state);
  const target = toLibraryRelativePath(state.libraryRoot, targetPath);
  assertNoTargetOverlap(
    state.journal.steps.map((step) => step.target),
    target,
  );
  const absoluteTarget = resolveLibraryRelativePath(state.libraryRoot, target);
  await assertPathWithinRootWithoutSymlinks(state.libraryRoot, absoluteTarget, {
    allowMissingTarget: !required,
  });
  const current = await pathState(absoluteTarget);
  if (current === "symlink" || current === "other") {
    throw new Error(`retire target이 안전하지 않습니다: ${absoluteTarget}`);
  }
  if (required && current === "missing") {
    throw new Error(`필수 retire target을 찾지 못했습니다: ${absoluteTarget}`);
  }
  if (
    current !== "missing" &&
    ((pathType === "file" && current !== "file") ||
      (pathType === "directory" && current !== "directory"))
  ) {
    throw new Error(`retire target type이 예상과 다릅니다: ${absoluteTarget}`);
  }

  const sequence = formatStepSequence(state.journal.steps.length + 1);
  const trash = `trash/${sequence}`;
  const trashPath = resolveTransactionRelativePath(state.root, trash, "trash");
  await mkdir(dirname(trashPath), { recursive: true });
  if ((await pathState(trashPath)) !== "missing") {
    throw new Error(`transaction trash path가 이미 존재합니다: ${trashPath}`);
  }
  const step: RetirePathStep = {
    kind: "retire-path",
    target,
    trash,
    pathType,
    required,
  };
  await appendJournalStep(state, step);
}

async function appendJournalStep(
  state: TransactionState,
  step: LibraryTransactionStep,
): Promise<void> {
  const next: LibraryTransactionJournal = {
    ...state.journal,
    steps: [...state.journal.steps, step],
  };
  validateLibraryTransactionJournalPaths(next);
  await writeJournal(state.root, next);
  state.journal = next;
}

async function sealLibraryTransaction(state: TransactionState): Promise<void> {
  assertStagingOpen(state);
  for (const step of state.journal.steps) {
    if (step.kind === "publish-directory") {
      const stagingDirectory = resolveTransactionRelativePath(
        state.root,
        step.staged,
        "staged",
      );
      await syncDirectoryTree(stagingDirectory);
    }
  }
  const next = { ...state.journal, sealed: true };
  await writeJournal(state.root, next);
  state.journal = next;
  await maybeInjectCrash("after-seal");
}

async function commitLibraryTransaction(
  state: TransactionState,
): Promise<void> {
  if (!state.journal.sealed || state.phase !== "active") {
    throw new Error("sealed active transaction만 commit할 수 있습니다.");
  }
  await withLibraryPublicationWrite(async () => {
    for (const step of state.journal.steps) {
      if (step.kind === "publish-directory") {
        await applyPublishDirectoryStep(state, step);
        await maybeInjectCrash("after-publish-step");
      }
    }
    for (const step of state.journal.steps) {
      if (step.kind === "replace-file") {
        await applyReplaceFileStep(state, step);
        await maybeInjectCrash("after-replace-step");
      }
    }
    for (const step of state.journal.steps) {
      if (step.kind === "retire-path") {
        await applyRetirePathStep(state, step);
        await maybeInjectCrash("after-retire-step");
      }
    }
    await maybeInjectCrash("before-commit-point");
    const committedRoot = join(
      state.libraryRoot,
      ".transactions",
      "committed",
      state.journal.id,
    );
    await durableRename(state.root, committedRoot);
    state.root = committedRoot;
    state.phase = "committed";
    state.committed = true;
    await maybeInjectCrash("after-commit-point");
  });

  await cleanupCommittedTransaction(state).catch((error) => {
    logLibraryWarning(
      "Committed library transaction cleanup failed; startup will retry",
      { transactionId: state.journal.id, error },
    );
  });
}

async function applyReplaceFileStep(
  state: TransactionState,
  step: ReplaceFileStep,
): Promise<void> {
  const target = resolveLibraryRelativePath(state.libraryRoot, step.target);
  const staged = resolveTransactionRelativePath(
    state.root,
    step.staged,
    "staged",
  );
  await assertPathWithinRootWithoutSymlinks(state.libraryRoot, target, {
    allowMissingTarget: !step.hadOriginal,
  });
  if ((await pathState(staged)) !== "file") {
    throw new Error(`staged replacement file을 찾지 못했습니다: ${staged}`);
  }
  if ((await sha256File(staged)) !== step.stagedSha256) {
    throw new Error(`staged replacement hash가 journal과 다릅니다: ${staged}`);
  }

  const current = await pathState(target);
  if (step.hadOriginal) {
    if (current !== "file") {
      throw new Error(`replace target 원본 상태가 변경되었습니다: ${target}`);
    }
    if ((await sha256File(target)) !== step.backupSha256) {
      throw new Error(`replace target hash conflict가 발생했습니다: ${target}`);
    }
  } else if (current !== "missing") {
    throw new Error(`새 replace target이 예상치 않게 존재합니다: ${target}`);
  }
  await durableRename(staged, target);
}

async function applyPublishDirectoryStep(
  state: TransactionState,
  step: PublishDirectoryStep,
): Promise<void> {
  const target = resolveLibraryRelativePath(state.libraryRoot, step.target);
  const staged = resolveTransactionRelativePath(
    state.root,
    step.staged,
    "staged",
  );
  await assertPathWithinRootWithoutSymlinks(state.libraryRoot, target, {
    allowMissingTarget: true,
  });
  if ((await pathState(target)) !== "missing") {
    throw new Error(`publish target이 이미 존재합니다: ${target}`);
  }
  await assertDirectoryWithoutSymlink(staged);
  await assertValidOwnerMarker(state, step, staged);
  await durableRename(staged, target);
}

async function applyRetirePathStep(
  state: TransactionState,
  step: RetirePathStep,
): Promise<void> {
  const target = resolveLibraryRelativePath(state.libraryRoot, step.target);
  const trash = resolveTransactionRelativePath(state.root, step.trash, "trash");
  await assertPathWithinRootWithoutSymlinks(state.libraryRoot, target, {
    allowMissingTarget: !step.required,
  });
  const current = await pathState(target);
  if (current === "missing") {
    if (step.required) {
      throw new Error(
        `필수 retire target이 commit 전에 사라졌습니다: ${target}`,
      );
    }
    return;
  }
  if (
    current === "symlink" ||
    current === "other" ||
    (step.pathType === "file" && current !== "file") ||
    (step.pathType === "directory" && current !== "directory")
  ) {
    throw new Error(`retire target 상태가 예상과 다릅니다: ${target}`);
  }
  if ((await pathState(trash)) !== "missing") {
    throw new Error(`transaction trash가 이미 존재합니다: ${trash}`);
  }
  await mkdir(dirname(trash), { recursive: true });
  await durableRename(target, trash);
}

async function rollbackTransactionState(
  state: TransactionState,
): Promise<void> {
  if (state.phase !== "active") {
    throw new Error("active transaction만 rollback할 수 있습니다.");
  }
  if (!state.journal.sealed) {
    await removeTree(state.root);
    return;
  }
  await withLibraryPublicationWrite(() =>
    rollbackLibraryTransactionDirectory({
      libraryRoot: state.libraryRoot,
      transactionRoot: state.root,
      journal: state.journal,
      removeAfterSuccess: true,
    }),
  );
}

export async function rollbackLibraryTransactionDirectory({
  libraryRoot,
  transactionRoot,
  journal,
  removeAfterSuccess,
}: {
  libraryRoot: string;
  transactionRoot: string;
  journal: LibraryTransactionJournal;
  removeAfterSuccess: boolean;
}): Promise<void> {
  validateLibraryTransactionJournalPaths(journal);
  for (const step of [...journal.steps].reverse()) {
    if (step.kind === "replace-file") {
      await rollbackReplaceFileStep(libraryRoot, transactionRoot, step);
    } else if (step.kind === "publish-directory") {
      await rollbackPublishDirectoryStep(
        libraryRoot,
        transactionRoot,
        journal.id,
        step,
      );
    } else {
      await rollbackRetirePathStep(libraryRoot, transactionRoot, step);
    }
  }
  if (removeAfterSuccess) {
    await removeTree(transactionRoot);
  }
}

// eslint-disable-next-line complexity -- hash/state conflict handling follows the explicit idempotent rollback matrix
async function rollbackReplaceFileStep(
  libraryRoot: string,
  transactionRoot: string,
  step: ReplaceFileStep,
): Promise<void> {
  const target = resolveLibraryRelativePath(libraryRoot, step.target);
  const current = await pathState(target);
  if (current === "symlink" || current === "directory" || current === "other") {
    throw new Error(
      `rollback replace target 상태가 안전하지 않습니다: ${target}`,
    );
  }

  if (!step.hadOriginal) {
    if (current === "missing") {
      return;
    }
    if ((await sha256File(target)) !== step.stagedSha256) {
      throw new Error(
        `rollback replace target hash conflict가 발생했습니다: ${target}`,
      );
    }
    await durableRemoveFile(target);
    return;
  }

  if (!step.backup || !step.backupSha256) {
    throw new Error("원본 replacement backup metadata가 없습니다.");
  }
  const backup = resolveTransactionRelativePath(
    transactionRoot,
    step.backup,
    "backups",
  );
  if ((await pathState(backup)) !== "file") {
    throw new Error(`rollback backup을 찾지 못했습니다: ${backup}`);
  }
  if ((await sha256File(backup)) !== step.backupSha256) {
    throw new Error(`rollback backup hash가 journal과 다릅니다: ${backup}`);
  }

  if (current === "file") {
    const targetHash = await sha256File(target);
    if (targetHash === step.backupSha256) {
      return;
    }
    if (targetHash !== step.stagedSha256) {
      throw new Error(
        `rollback replace target hash conflict가 발생했습니다: ${target}`,
      );
    }
  }
  await restoreBackupAtomically(backup, target);
}

async function rollbackPublishDirectoryStep(
  libraryRoot: string,
  transactionRoot: string,
  transactionId: string,
  step: PublishDirectoryStep,
): Promise<void> {
  const target = resolveLibraryRelativePath(libraryRoot, step.target);
  const staged = resolveTransactionRelativePath(
    transactionRoot,
    step.staged,
    "staged",
  );
  const stagedState = await pathState(staged);
  const targetState = await pathState(target);
  if (stagedState === "directory" && targetState === "missing") {
    return;
  }
  if (stagedState === "missing" && targetState === "directory") {
    await assertOwnerMarkerAtPublishedTarget(transactionId, step, target);
    await durableRename(target, staged);
    return;
  }
  throw new Error(
    `publish-directory rollback conflict: staged=${stagedState}, target=${targetState}`,
  );
}

async function rollbackRetirePathStep(
  libraryRoot: string,
  transactionRoot: string,
  step: RetirePathStep,
): Promise<void> {
  const target = resolveLibraryRelativePath(libraryRoot, step.target);
  const trash = resolveTransactionRelativePath(
    transactionRoot,
    step.trash,
    "trash",
  );
  const targetState = await pathState(target);
  const trashState = await pathState(trash);
  const expected = step.pathType;

  if (targetState === expected && trashState === "missing") {
    return;
  }
  if (targetState === "missing" && trashState === expected) {
    await mkdir(dirname(target), { recursive: true });
    await durableRename(trash, target);
    return;
  }
  if (!step.required && targetState === "missing" && trashState === "missing") {
    return;
  }
  throw new Error(
    `retire-path rollback conflict: target=${targetState}, trash=${trashState}`,
  );
}

async function cleanupCommittedTransaction(
  state: TransactionState,
): Promise<void> {
  if (!state.committed || state.phase !== "committed") {
    return;
  }
  for (const step of state.journal.steps) {
    if (step.kind !== "publish-directory") {
      continue;
    }
    const target = resolveLibraryRelativePath(state.libraryRoot, step.target);
    try {
      await removePublishedOwnerMarker(state.journal.id, step, target);
      await maybeInjectCrash("owner-marker-cleanup");
    } catch (error) {
      logLibraryWarning("Published transaction owner marker cleanup failed", {
        transactionId: state.journal.id,
        target: step.target,
        error,
      });
      return;
    }
  }
  try {
    await maybeInjectCrash("committed-dir-cleanup");
    await removeTree(state.root);
  } catch (error) {
    logLibraryWarning("Committed transaction directory cleanup failed", {
      transactionId: state.journal.id,
      error,
    });
  }
}

export async function cleanupCommittedTransactionDirectory({
  libraryRoot,
  transactionRoot,
  journal,
}: {
  libraryRoot: string;
  transactionRoot: string;
  journal: LibraryTransactionJournal;
}): Promise<void> {
  validateLibraryTransactionJournalPaths(journal);
  for (const step of journal.steps) {
    if (step.kind !== "publish-directory") {
      continue;
    }
    const target = resolveLibraryRelativePath(libraryRoot, step.target);
    await removePublishedOwnerMarker(journal.id, step, target);
  }
  await removeTree(transactionRoot);
}

async function removePublishedOwnerMarker(
  transactionId: string,
  step: PublishDirectoryStep,
  target: string,
): Promise<void> {
  const targetState = await pathState(target);
  if (targetState !== "directory") {
    throw new Error(`committed publish target을 찾지 못했습니다: ${target}`);
  }
  const markerPath = publishedOwnerMarkerPath(step, target);
  const markerState = await pathState(markerPath);
  if (markerState === "missing") {
    return;
  }
  if (markerState !== "file") {
    throw new Error(`owner marker가 regular file이 아닙니다: ${markerPath}`);
  }
  await assertOwnerMarkerAtPublishedTarget(transactionId, step, target);
  await durableRemoveFile(markerPath);
}

async function assertValidOwnerMarker(
  state: TransactionState,
  step: PublishDirectoryStep,
  stagedDirectory: string,
): Promise<void> {
  const markerPath = resolveTransactionRelativePath(
    state.root,
    step.ownerMarker,
    "staged",
  );
  const relativeMarker = relative(stagedDirectory, markerPath);
  if (
    !relativeMarker ||
    relativeMarker.startsWith("..") ||
    relativeMarker.split(sep).join("/") !== TRANSACTION_OWNER_MARKER
  ) {
    throw new Error("publish owner marker path가 올바르지 않습니다.");
  }
  await assertOwnerMarker(markerPath, state.journal.id, step.target);
}

async function assertOwnerMarkerAtPublishedTarget(
  transactionId: string,
  step: PublishDirectoryStep,
  target: string,
): Promise<void> {
  await assertOwnerMarker(
    publishedOwnerMarkerPath(step, target),
    transactionId,
    step.target,
  );
}

function publishedOwnerMarkerPath(
  step: PublishDirectoryStep,
  target: string,
): string {
  const suffix = step.ownerMarker.slice(step.staged.length + 1);
  validateCanonicalRelativePath(suffix, "owner marker suffix");
  return join(target, ...suffix.split("/"));
}

async function assertOwnerMarker(
  markerPath: string,
  transactionId: string,
  target: string,
): Promise<void> {
  const raw = await readBoundedJsonFile(markerPath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("transaction owner marker 형식이 올바르지 않습니다.");
  }
  const marker = raw as Record<string, unknown>;
  if (
    marker.schemaVersion !== 1 ||
    marker.transactionId !== transactionId ||
    marker.target !== target ||
    Object.keys(marker).some(
      (key) => !["schemaVersion", "transactionId", "target"].includes(key),
    )
  ) {
    throw new Error("transaction owner marker가 journal과 일치하지 않습니다.");
  }
}

async function writeJournal(
  transactionRoot: string,
  journal: LibraryTransactionJournal,
): Promise<void> {
  const checked = LibraryTransactionJournalSchema.parse(journal);
  validateLibraryTransactionJournalPaths(checked);
  const bytes = Buffer.from(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_LIBRARY_TRANSACTION_JOURNAL_BYTES) {
    throw new Error("transaction journal이 허용 크기를 초과했습니다.");
  }
  await writeDurableFile(join(transactionRoot, "journal.json"), bytes);
}

export async function readAndValidateTransactionJournal(
  transactionRoot: string,
  expectedId: string,
): Promise<LibraryTransactionJournal> {
  const raw = await readBoundedJsonFile(join(transactionRoot, "journal.json"));
  const journal = LibraryTransactionJournalSchema.parse(raw);
  if (journal.id !== expectedId) {
    throw new Error(
      "transaction directory ID와 journal ID가 일치하지 않습니다.",
    );
  }
  validateLibraryTransactionJournalPaths(journal);
  return journal;
}

function assertStagingOpen(state: TransactionState): void {
  if (state.phase !== "active" || state.journal.sealed) {
    throw new Error(
      "sealed/committed transaction에는 새 step을 추가할 수 없습니다.",
    );
  }
}

function formatStepSequence(value: number): string {
  return String(value).padStart(6, "0");
}

async function maybeInjectCrash(
  point: LibraryTransactionCrashPoint,
): Promise<void> {
  if (crashInjector) {
    await crashInjector(point);
  }
}

export function isLibraryTransactionDirectoryName(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
