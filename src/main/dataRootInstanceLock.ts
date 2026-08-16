/* eslint-disable complexity, max-depth, max-lines, max-lines-per-function -- acquisition, stale reclaim, strict parsing, and token-checked release stay co-located for security auditability */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

export const DATA_ROOT_INSTANCE_LOCK_DIRECTORY = ".mgt-instance-lock";
export const DATA_ROOT_INSTANCE_LOCK_OWNER_FILE = "owner.json";

const DATA_ROOT_INSTANCE_RECLAIM_FILE = "reclaim.json";
const MAX_OWNER_FILE_BYTES = 16 * 1024;
const MAX_ACQUIRE_ATTEMPTS = 8;
const MAX_TRANSIENT_RENAME_ATTEMPTS = 8;
const MAX_TOKEN_LENGTH = 128;
const FILESYSTEM_RETRY_SIGNAL = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

export type DataRootInstanceLockOwner = {
  schemaVersion: 1;
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
  executablePath: string;
  appVersion: string;
  dataRoot: string;
};

type ReclaimOwner = {
  schemaVersion: 1;
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
};

export type DataRootInstanceLockRuntime = {
  now: () => Date;
  createToken: () => string;
  getHostname: () => string;
  processId: number;
  executablePath: string;
  appVersion: string;
  isProcessAlive: (pid: number) => boolean;
};

export type DataRootInstanceLockHooks = {
  afterCanonicalOwnerFileInspected?: () => void;
  afterInitialOwnerRead?: (owner: Readonly<DataRootInstanceLockOwner>) => void;
  afterReclaimMarkerCreated?: (
    owner: Readonly<DataRootInstanceLockOwner>,
  ) => void;
  afterReclaimMarkerInspected?: () => void;
  afterReclaimRename?: (quarantineDirectory: string) => void;
  beforeStaleReclaimMarkerQuarantine?: () => void;
  afterReleaseOwnerRead?: (owner: Readonly<DataRootInstanceLockOwner>) => void;
  afterReleaseRename?: (releaseDirectory: string) => void;
};

export type DataRootInstanceLockLease = {
  readonly dataRoot: string;
  readonly lockDirectory: string;
  readonly owner: Readonly<DataRootInstanceLockOwner>;
  readonly reclaimedOwner?: Readonly<DataRootInstanceLockOwner>;
  release: () => void;
};

export type DataRootInstanceLockHeldReason =
  | "live-process"
  | "foreign-host"
  | "reclaim-in-progress";

export type DataRootInstanceLockInvalidReason =
  | "lock-path-not-directory"
  | "lock-path-is-symbolic-link"
  | "lock-path-unreadable"
  | "owner-missing"
  | "owner-not-file"
  | "owner-is-symbolic-link"
  | "owner-too-large"
  | "owner-unreadable"
  | "owner-json-invalid"
  | "owner-schema-invalid"
  | "owner-data-root-mismatch"
  | "reclaim-metadata-invalid"
  | "lock-state-unstable";

export class DataRootInstanceLockHeldError extends Error {
  readonly code = "DATA_ROOT_INSTANCE_LOCK_HELD";

  constructor(
    message: string,
    readonly dataRoot: string,
    readonly lockDirectory: string,
    readonly owner: Readonly<DataRootInstanceLockOwner>,
    readonly reason: DataRootInstanceLockHeldReason,
  ) {
    super(message);
    this.name = "DataRootInstanceLockHeldError";
  }
}

export class DataRootInstanceLockInvalidError extends Error {
  readonly code = "DATA_ROOT_INSTANCE_LOCK_INVALID";

  constructor(
    message: string,
    readonly dataRoot: string,
    readonly lockDirectory: string,
    readonly reason: DataRootInstanceLockInvalidReason,
  ) {
    super(message);
    this.name = "DataRootInstanceLockInvalidError";
  }
}

export class DataRootInstanceLockLostError extends Error {
  readonly code = "DATA_ROOT_INSTANCE_LOCK_LOST";

  constructor(
    message: string,
    readonly dataRoot: string,
    readonly lockDirectory: string,
  ) {
    super(message);
    this.name = "DataRootInstanceLockLostError";
  }
}

class LockObservationRetryError extends Error {}

export function isProcessAliveFailClosed(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export function createProductionDataRootInstanceLockRuntime(
  appVersion: string,
): DataRootInstanceLockRuntime {
  return {
    now: () => new Date(),
    createToken: () => randomUUID(),
    getHostname: () => hostname(),
    processId: process.pid,
    executablePath: process.execPath,
    appVersion,
    isProcessAlive: isProcessAliveFailClosed,
  };
}

export function canonicalizeDataRoot(dataRoot: string): string {
  const resolvedDataRoot = resolve(dataRoot);
  mkdirSync(resolvedDataRoot, { recursive: true });
  return realpathSync.native(resolvedDataRoot);
}

export function acquireDataRootInstanceLock(
  dataRoot: string,
  runtime: DataRootInstanceLockRuntime,
  hooks: DataRootInstanceLockHooks = {},
): DataRootInstanceLockLease {
  const canonicalDataRoot = canonicalizeDataRoot(dataRoot);
  const lockDirectory = join(
    canonicalDataRoot,
    DATA_ROOT_INSTANCE_LOCK_DIRECTORY,
  );
  const owner = createOwner(canonicalDataRoot, runtime);
  const candidateDirectory = createPreparedCandidate(canonicalDataRoot, owner);
  let reclaimedOwner: DataRootInstanceLockOwner | undefined;

  try {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      if (tryPublishCandidate(candidateDirectory, lockDirectory)) {
        return createLease(
          canonicalDataRoot,
          lockDirectory,
          owner,
          reclaimedOwner,
          hooks,
        );
      }

      let observedOwner: DataRootInstanceLockOwner;
      try {
        observedOwner = readCanonicalOwner(
          canonicalDataRoot,
          lockDirectory,
          hooks.afterCanonicalOwnerFileInspected,
        );
      } catch (error) {
        if (error instanceof LockObservationRetryError) {
          continue;
        }
        throw error;
      }
      hooks.afterInitialOwnerRead?.(observedOwner);

      if (!sameHostname(observedOwner.hostname, runtime.getHostname())) {
        throw new DataRootInstanceLockHeldError(
          "The data root is locked by a process on another host.",
          canonicalDataRoot,
          lockDirectory,
          observedOwner,
          "foreign-host",
        );
      }
      if (runtime.isProcessAlive(observedOwner.pid)) {
        throw new DataRootInstanceLockHeldError(
          "The data root is already in use by a live process.",
          canonicalDataRoot,
          lockDirectory,
          observedOwner,
          "live-process",
        );
      }

      const reclaimed = tryReclaimStaleLock({
        canonicalDataRoot,
        lockDirectory,
        candidateDirectory,
        observedOwner,
        owner,
        runtime,
        hooks,
      });
      if (reclaimed === "acquired") {
        reclaimedOwner = observedOwner;
        return createLease(
          canonicalDataRoot,
          lockDirectory,
          owner,
          reclaimedOwner,
          hooks,
        );
      }
    }

    throw new DataRootInstanceLockInvalidError(
      "The data-root lock changed too many times during acquisition.",
      canonicalDataRoot,
      lockDirectory,
      "lock-state-unstable",
    );
  } catch (error) {
    removeOwnedCandidate(candidateDirectory);
    throw error;
  }
}

function createOwner(
  canonicalDataRoot: string,
  runtime: DataRootInstanceLockRuntime,
): DataRootInstanceLockOwner {
  const token = runtime.createToken();
  assertSafeToken(token);
  const processHostname = runtime.getHostname().trim();
  if (!processHostname || processHostname.length > 255) {
    throw new Error("Cannot create a data-root lock with an invalid hostname.");
  }
  if (!Number.isSafeInteger(runtime.processId) || runtime.processId <= 0) {
    throw new Error("Cannot create a data-root lock with an invalid PID.");
  }

  return {
    schemaVersion: 1,
    token,
    pid: runtime.processId,
    hostname: processHostname,
    startedAt: runtime.now().toISOString(),
    executablePath: runtime.executablePath,
    appVersion: runtime.appVersion,
    dataRoot: canonicalDataRoot,
  };
}

function assertSafeToken(token: string): void {
  if (
    !token ||
    token.length > MAX_TOKEN_LENGTH ||
    !/^[A-Za-z0-9._-]+$/.test(token)
  ) {
    throw new Error("The data-root lock token is invalid.");
  }
}

function createPreparedCandidate(
  dataRoot: string,
  owner: DataRootInstanceLockOwner,
): string {
  const candidateDirectory = join(
    dataRoot,
    `.mgt-instance-candidate-${owner.token}`,
  );
  mkdirSync(candidateDirectory, { mode: 0o700 });
  try {
    writeFileSync(
      join(candidateDirectory, DATA_ROOT_INSTANCE_LOCK_OWNER_FILE),
      `${JSON.stringify(owner, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    return candidateDirectory;
  } catch (error) {
    rmSync(candidateDirectory, { recursive: true, force: true });
    throw error;
  }
}

function tryPublishCandidate(
  candidateDirectory: string,
  canonicalLockDirectory: string,
): boolean {
  if (existsSync(canonicalLockDirectory)) {
    return false;
  }
  try {
    renameSync(candidateDirectory, canonicalLockDirectory);
    return true;
  } catch (error) {
    if (existsSync(canonicalLockDirectory)) {
      return false;
    }
    throw error;
  }
}

function removeOwnedCandidate(candidateDirectory: string): void {
  if (!existsSync(candidateDirectory)) {
    return;
  }
  rmSync(candidateDirectory, { recursive: true, force: true });
}

function tryReclaimStaleLock(options: {
  canonicalDataRoot: string;
  lockDirectory: string;
  candidateDirectory: string;
  observedOwner: DataRootInstanceLockOwner;
  owner: DataRootInstanceLockOwner;
  runtime: DataRootInstanceLockRuntime;
  hooks: DataRootInstanceLockHooks;
}): "acquired" | "retry" {
  const {
    canonicalDataRoot,
    lockDirectory,
    candidateDirectory,
    observedOwner,
    owner,
    runtime,
    hooks,
  } = options;
  const reclaimOwner = createReclaimOwner(owner);
  try {
    claimReclaimMarker(
      canonicalDataRoot,
      lockDirectory,
      observedOwner,
      reclaimOwner,
      runtime,
      hooks,
    );
  } catch (error) {
    if (error instanceof LockObservationRetryError) {
      return "retry";
    }
    throw error;
  }
  hooks.afterReclaimMarkerCreated?.(observedOwner);

  let currentOwner: DataRootInstanceLockOwner;
  try {
    currentOwner = readCanonicalOwner(
      canonicalDataRoot,
      lockDirectory,
      hooks.afterCanonicalOwnerFileInspected,
    );
  } catch (error) {
    if (error instanceof LockObservationRetryError) {
      return "retry";
    }
    throw error;
  }
  if (!sameOwnerIdentity(currentOwner, observedOwner)) {
    removeOwnedReclaimMarker(canonicalDataRoot, lockDirectory, reclaimOwner);
    return "retry";
  }
  if (runtime.isProcessAlive(currentOwner.pid)) {
    removeOwnedReclaimMarker(canonicalDataRoot, lockDirectory, reclaimOwner);
    throw new DataRootInstanceLockHeldError(
      "The stale lock owner became live during reclamation.",
      canonicalDataRoot,
      lockDirectory,
      currentOwner,
      "live-process",
    );
  }

  const quarantineDirectory = join(
    canonicalDataRoot,
    `.mgt-instance-stale-${owner.token}`,
  );
  if (
    !renameWithTransientContentionRetries(lockDirectory, quarantineDirectory)
  ) {
    return "retry";
  }
  hooks.afterReclaimRename?.(quarantineDirectory);

  try {
    const quarantinedOwner = readOwnerFromDirectory(
      canonicalDataRoot,
      quarantineDirectory,
    );
    const quarantinedReclaimOwner = readReclaimOwner(
      canonicalDataRoot,
      quarantineDirectory,
    );
    if (
      !sameOwnerIdentity(quarantinedOwner, observedOwner) ||
      !sameReclaimIdentity(quarantinedReclaimOwner, reclaimOwner)
    ) {
      restoreQuarantineIfPossible(quarantineDirectory, lockDirectory);
      throw new DataRootInstanceLockInvalidError(
        "The quarantined stale lock did not match the observed owner.",
        canonicalDataRoot,
        lockDirectory,
        "reclaim-metadata-invalid",
      );
    }

    if (tryPublishCandidate(candidateDirectory, lockDirectory)) {
      try {
        rmSync(quarantineDirectory, { recursive: true, force: false });
      } catch (error) {
        console.error(
          "Failed to remove a verified stale lock quarantine",
          error,
        );
      }
      return "acquired";
    }

    rmSync(quarantineDirectory, { recursive: true, force: false });
    return "retry";
  } catch (error) {
    if (!existsSync(lockDirectory) && existsSync(quarantineDirectory)) {
      restoreQuarantineIfPossible(quarantineDirectory, lockDirectory);
    }
    throw error;
  }
}

function createReclaimOwner(owner: DataRootInstanceLockOwner): ReclaimOwner {
  return {
    schemaVersion: 1,
    token: owner.token,
    pid: owner.pid,
    hostname: owner.hostname,
    startedAt: owner.startedAt,
  };
}

function claimReclaimMarker(
  canonicalDataRoot: string,
  lockDirectory: string,
  observedOwner: DataRootInstanceLockOwner,
  reclaimOwner: ReclaimOwner,
  runtime: DataRootInstanceLockRuntime,
  hooks: DataRootInstanceLockHooks,
): void {
  const markerPath = join(lockDirectory, DATA_ROOT_INSTANCE_RECLAIM_FILE);
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      writeFileSync(markerPath, `${JSON.stringify(reclaimOwner, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return;
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) {
        if (!existsSync(lockDirectory)) {
          throw new LockObservationRetryError();
        }
        throw error;
      }
    }

    const existingMarker = readReclaimOwner(
      canonicalDataRoot,
      lockDirectory,
      "retry",
      hooks.afterReclaimMarkerInspected,
    );
    if (!sameHostname(existingMarker.hostname, runtime.getHostname())) {
      throw new DataRootInstanceLockHeldError(
        "A foreign host owns the stale-lock reclamation marker.",
        canonicalDataRoot,
        lockDirectory,
        observedOwner,
        "foreign-host",
      );
    }
    if (runtime.isProcessAlive(existingMarker.pid)) {
      throw new DataRootInstanceLockHeldError(
        "Another live process is reclaiming the data-root lock.",
        canonicalDataRoot,
        lockDirectory,
        observedOwner,
        "reclaim-in-progress",
      );
    }
    hooks.beforeStaleReclaimMarkerQuarantine?.();
    quarantineAndRemoveStaleReclaimMarker(
      canonicalDataRoot,
      lockDirectory,
      existingMarker,
      reclaimOwner.token,
    );
  }

  throw new DataRootInstanceLockInvalidError(
    "The reclaim marker changed too many times.",
    canonicalDataRoot,
    lockDirectory,
    "lock-state-unstable",
  );
}

function quarantineAndRemoveStaleReclaimMarker(
  canonicalDataRoot: string,
  lockDirectory: string,
  observedMarker: ReclaimOwner,
  reclaimerToken: string,
): void {
  const markerPath = join(lockDirectory, DATA_ROOT_INSTANCE_RECLAIM_FILE);
  const quarantinePath = join(
    lockDirectory,
    `.mgt-instance-reclaim-stale-${reclaimerToken}.json`,
  );
  try {
    renameSync(markerPath, quarantinePath);
  } catch (error) {
    if (!existsSync(markerPath)) {
      return;
    }
    throw error;
  }
  const quarantinedMarker = readReclaimOwnerFile(
    canonicalDataRoot,
    lockDirectory,
    quarantinePath,
  );
  if (!sameReclaimIdentity(quarantinedMarker, observedMarker)) {
    if (restoreQuarantinedFileIfPossible(quarantinePath, markerPath)) {
      throw new LockObservationRetryError();
    }
    throw new DataRootInstanceLockInvalidError(
      "The stale reclaim marker changed while being quarantined.",
      canonicalDataRoot,
      lockDirectory,
      "reclaim-metadata-invalid",
    );
  }
  rmSync(quarantinePath, { force: false });
}

function removeOwnedReclaimMarker(
  canonicalDataRoot: string,
  lockDirectory: string,
  reclaimOwner: ReclaimOwner,
): void {
  const markerPath = join(lockDirectory, DATA_ROOT_INSTANCE_RECLAIM_FILE);
  const currentMarker = readReclaimOwner(canonicalDataRoot, lockDirectory);
  if (!sameReclaimIdentity(currentMarker, reclaimOwner)) {
    throw new DataRootInstanceLockInvalidError(
      "The reclaim marker is no longer owned by this process.",
      canonicalDataRoot,
      lockDirectory,
      "reclaim-metadata-invalid",
    );
  }
  const quarantinePath = join(
    lockDirectory,
    `.mgt-instance-reclaim-release-${reclaimOwner.token}.json`,
  );
  renameSync(markerPath, quarantinePath);
  const quarantinedMarker = readReclaimOwnerFile(
    canonicalDataRoot,
    lockDirectory,
    quarantinePath,
  );
  if (!sameReclaimIdentity(quarantinedMarker, reclaimOwner)) {
    throw new DataRootInstanceLockInvalidError(
      "The reclaim marker changed while being released.",
      canonicalDataRoot,
      lockDirectory,
      "reclaim-metadata-invalid",
    );
  }
  rmSync(quarantinePath, { force: false });
}

function renameWithTransientContentionRetries(
  sourcePath: string,
  destinationPath: string,
): boolean {
  for (let attempt = 0; attempt < MAX_TRANSIENT_RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameSync(sourcePath, destinationPath);
      return true;
    } catch (error) {
      if (!existsSync(sourcePath)) {
        return false;
      }
      if (
        !isTransientFilesystemContention(error) ||
        attempt === MAX_TRANSIENT_RENAME_ATTEMPTS - 1
      ) {
        throw error;
      }
      Atomics.wait(
        FILESYSTEM_RETRY_SIGNAL,
        0,
        0,
        Math.min(5 * 2 ** attempt, 40),
      );
    }
  }
  return false;
}

function isTransientFilesystemContention(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EPERM"].some((code) =>
    isNodeErrorCode(error, code),
  );
}

function restoreQuarantinedFileIfPossible(
  quarantinePath: string,
  originalPath: string,
): boolean {
  if (!existsSync(quarantinePath) || existsSync(originalPath)) {
    return false;
  }
  try {
    renameSync(quarantinePath, originalPath);
    return true;
  } catch (error) {
    if (existsSync(originalPath)) {
      return false;
    }
    throw error;
  }
}

function restoreQuarantineIfPossible(
  quarantineDirectory: string,
  canonicalLockDirectory: string,
): void {
  if (existsSync(quarantineDirectory) && !existsSync(canonicalLockDirectory)) {
    renameSync(quarantineDirectory, canonicalLockDirectory);
  }
}

function createLease(
  dataRoot: string,
  lockDirectory: string,
  owner: DataRootInstanceLockOwner,
  reclaimedOwner: DataRootInstanceLockOwner | undefined,
  hooks: DataRootInstanceLockHooks,
): DataRootInstanceLockLease {
  let released = false;
  return {
    dataRoot,
    lockDirectory,
    owner: Object.freeze({ ...owner }),
    ...(reclaimedOwner
      ? { reclaimedOwner: Object.freeze({ ...reclaimedOwner }) }
      : {}),
    release: () => {
      if (released) {
        return;
      }
      const currentOwner = readOwnerForRelease(dataRoot, lockDirectory);
      if (currentOwner.token !== owner.token) {
        throw new DataRootInstanceLockLostError(
          "The data-root lock is owned by another process.",
          dataRoot,
          lockDirectory,
        );
      }
      hooks.afterReleaseOwnerRead?.(currentOwner);

      const releaseDirectory = join(
        dataRoot,
        `.mgt-instance-release-${owner.token}`,
      );
      try {
        renameSync(lockDirectory, releaseDirectory);
      } catch (error) {
        throw new DataRootInstanceLockLostError(
          `The data-root lock could not be quarantined for release: ${formatError(error)}`,
          dataRoot,
          lockDirectory,
        );
      }
      hooks.afterReleaseRename?.(releaseDirectory);

      const quarantinedOwner = readOwnerFromDirectory(
        dataRoot,
        releaseDirectory,
      );
      if (quarantinedOwner.token !== owner.token) {
        restoreQuarantineIfPossible(releaseDirectory, lockDirectory);
        throw new DataRootInstanceLockLostError(
          "The quarantined data-root lock owner token changed.",
          dataRoot,
          lockDirectory,
        );
      }
      rmSync(releaseDirectory, { recursive: true, force: false });
      released = true;
    },
  };
}

function readOwnerForRelease(
  dataRoot: string,
  lockDirectory: string,
): DataRootInstanceLockOwner {
  try {
    return readCanonicalOwner(dataRoot, lockDirectory);
  } catch (error) {
    if (error instanceof LockObservationRetryError) {
      throw new DataRootInstanceLockLostError(
        "The data-root lock disappeared before release.",
        dataRoot,
        lockDirectory,
      );
    }
    throw error;
  }
}

function readCanonicalOwner(
  canonicalDataRoot: string,
  lockDirectory: string,
  afterInspect?: () => void,
): DataRootInstanceLockOwner {
  if (!existsSync(lockDirectory)) {
    throw new LockObservationRetryError();
  }
  return readOwnerFromDirectory(
    canonicalDataRoot,
    lockDirectory,
    "retry",
    afterInspect,
  );
}

function readOwnerFromDirectory(
  canonicalDataRoot: string,
  lockDirectory: string,
  missingBehavior: "invalid" | "retry" = "invalid",
  afterInspect?: () => void,
): DataRootInstanceLockOwner {
  const directoryStat = safeLstat(
    lockDirectory,
    canonicalDataRoot,
    lockDirectory,
    "lock-path-unreadable",
  );
  if (directoryStat.isSymbolicLink()) {
    throw new DataRootInstanceLockInvalidError(
      "The data-root lock path is a symbolic link.",
      canonicalDataRoot,
      lockDirectory,
      "lock-path-is-symbolic-link",
    );
  }
  if (!directoryStat.isDirectory()) {
    throw new DataRootInstanceLockInvalidError(
      "The data-root lock path is not a directory.",
      canonicalDataRoot,
      lockDirectory,
      "lock-path-not-directory",
    );
  }

  const ownerPath = join(lockDirectory, DATA_ROOT_INSTANCE_LOCK_OWNER_FILE);
  let ownerStat;
  try {
    ownerStat = lstatSync(ownerPath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") && !existsSync(lockDirectory)) {
      throw new LockObservationRetryError();
    }
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new DataRootInstanceLockInvalidError(
        "The data-root lock owner file is missing.",
        canonicalDataRoot,
        lockDirectory,
        "owner-missing",
      );
    }
    throw new DataRootInstanceLockInvalidError(
      `The data-root lock owner file is unreadable: ${formatError(error)}`,
      canonicalDataRoot,
      lockDirectory,
      "owner-unreadable",
    );
  }
  if (ownerStat.isSymbolicLink()) {
    throw new DataRootInstanceLockInvalidError(
      "The data-root lock owner file is a symbolic link.",
      canonicalDataRoot,
      lockDirectory,
      "owner-is-symbolic-link",
    );
  }
  if (!ownerStat.isFile()) {
    throw new DataRootInstanceLockInvalidError(
      "The data-root lock owner path is not a regular file.",
      canonicalDataRoot,
      lockDirectory,
      "owner-not-file",
    );
  }
  if (ownerStat.size > MAX_OWNER_FILE_BYTES) {
    throw new DataRootInstanceLockInvalidError(
      "The data-root lock owner file is too large.",
      canonicalDataRoot,
      lockDirectory,
      "owner-too-large",
    );
  }
  afterInspect?.();

  let rawOwner: string;
  try {
    rawOwner = readFileSync(ownerPath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") && missingBehavior === "retry") {
      throw new LockObservationRetryError();
    }
    throw new DataRootInstanceLockInvalidError(
      `The data-root lock owner file could not be read: ${formatError(error)}`,
      canonicalDataRoot,
      lockDirectory,
      "owner-unreadable",
    );
  }
  const parsed = parseJsonObject(
    rawOwner,
    canonicalDataRoot,
    lockDirectory,
    "owner-json-invalid",
  );
  const owner = parseOwnerObject(parsed, canonicalDataRoot, lockDirectory);
  if (owner.dataRoot !== canonicalDataRoot) {
    throw new DataRootInstanceLockInvalidError(
      "The data-root lock owner references another data root.",
      canonicalDataRoot,
      lockDirectory,
      "owner-data-root-mismatch",
    );
  }
  return owner;
}

function readReclaimOwner(
  canonicalDataRoot: string,
  lockDirectory: string,
  missingBehavior: "invalid" | "retry" = "invalid",
  afterInspect?: () => void,
): ReclaimOwner {
  return readReclaimOwnerFile(
    canonicalDataRoot,
    lockDirectory,
    join(lockDirectory, DATA_ROOT_INSTANCE_RECLAIM_FILE),
    missingBehavior,
    afterInspect,
  );
}

function readReclaimOwnerFile(
  canonicalDataRoot: string,
  lockDirectory: string,
  markerPath: string,
  missingBehavior: "invalid" | "retry" = "invalid",
  afterInspect?: () => void,
): ReclaimOwner {
  let markerStat;
  try {
    markerStat = lstatSync(markerPath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") && missingBehavior === "retry") {
      throw new LockObservationRetryError();
    }
    throw new DataRootInstanceLockInvalidError(
      `The reclaim marker could not be inspected: ${formatError(error)}`,
      canonicalDataRoot,
      lockDirectory,
      "reclaim-metadata-invalid",
    );
  }
  if (
    markerStat.isSymbolicLink() ||
    !markerStat.isFile() ||
    markerStat.size > MAX_OWNER_FILE_BYTES
  ) {
    throw new DataRootInstanceLockInvalidError(
      "The reclaim marker is not a valid regular file.",
      canonicalDataRoot,
      lockDirectory,
      "reclaim-metadata-invalid",
    );
  }
  afterInspect?.();

  let rawMarker: string;
  try {
    rawMarker = readFileSync(markerPath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") && missingBehavior === "retry") {
      throw new LockObservationRetryError();
    }
    throw new DataRootInstanceLockInvalidError(
      `The reclaim marker could not be read: ${formatError(error)}`,
      canonicalDataRoot,
      lockDirectory,
      "reclaim-metadata-invalid",
    );
  }
  const parsed = parseJsonObject(
    rawMarker,
    canonicalDataRoot,
    lockDirectory,
    "reclaim-metadata-invalid",
  );
  if (
    !hasExactKeys(parsed, [
      "schemaVersion",
      "token",
      "pid",
      "hostname",
      "startedAt",
    ])
  ) {
    throw new DataRootInstanceLockInvalidError(
      "The reclaim marker schema is invalid.",
      canonicalDataRoot,
      lockDirectory,
      "reclaim-metadata-invalid",
    );
  }

  try {
    return {
      schemaVersion: requireSchemaVersion(parsed.schemaVersion),
      token: requireToken(parsed.token),
      pid: requirePid(parsed.pid),
      hostname: requireBoundedString(parsed.hostname, 255),
      startedAt: requireDateString(parsed.startedAt),
    };
  } catch (error) {
    throw new DataRootInstanceLockInvalidError(
      `The reclaim marker schema is invalid: ${formatError(error)}`,
      canonicalDataRoot,
      lockDirectory,
      "reclaim-metadata-invalid",
    );
  }
}

function parseOwnerObject(
  parsed: Record<string, unknown>,
  canonicalDataRoot: string,
  lockDirectory: string,
): DataRootInstanceLockOwner {
  if (
    !hasExactKeys(parsed, [
      "schemaVersion",
      "token",
      "pid",
      "hostname",
      "startedAt",
      "executablePath",
      "appVersion",
      "dataRoot",
    ])
  ) {
    throw new DataRootInstanceLockInvalidError(
      "The data-root lock owner schema is invalid.",
      canonicalDataRoot,
      lockDirectory,
      "owner-schema-invalid",
    );
  }

  try {
    return {
      schemaVersion: requireSchemaVersion(parsed.schemaVersion),
      token: requireToken(parsed.token),
      pid: requirePid(parsed.pid),
      hostname: requireBoundedString(parsed.hostname, 255),
      startedAt: requireDateString(parsed.startedAt),
      executablePath: requireBoundedString(parsed.executablePath, 4096, true),
      appVersion: requireBoundedString(parsed.appVersion, 128, true),
      dataRoot: requireBoundedString(parsed.dataRoot, 4096),
    };
  } catch (error) {
    throw new DataRootInstanceLockInvalidError(
      `The data-root lock owner schema is invalid: ${formatError(error)}`,
      canonicalDataRoot,
      lockDirectory,
      "owner-schema-invalid",
    );
  }
}

function parseJsonObject(
  rawValue: string,
  dataRoot: string,
  lockDirectory: string,
  reason: DataRootInstanceLockInvalidReason,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new DataRootInstanceLockInvalidError(
      `Lock metadata is not valid JSON: ${formatError(error)}`,
      dataRoot,
      lockDirectory,
      reason,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DataRootInstanceLockInvalidError(
      "Lock metadata must be a JSON object.",
      dataRoot,
      lockDirectory,
      reason,
    );
  }
  return parsed as Record<string, unknown>;
}

function requireSchemaVersion(value: unknown): 1 {
  if (value !== 1) {
    throw new Error("schemaVersion must equal 1");
  }
  return 1;
}

function requireToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("token must be a string");
  }
  assertSafeToken(value);
  return value;
}

function requirePid(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error("pid must be a positive safe integer");
  }
  return Number(value);
}

function requireBoundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength
  ) {
    throw new Error("metadata string is outside the allowed bounds");
  }
  return value;
}

function requireDateString(value: unknown): string {
  const dateValue = requireBoundedString(value, 128);
  if (!Number.isFinite(Date.parse(dateValue))) {
    throw new Error("startedAt must be a valid date");
  }
  return dateValue;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function safeLstat(
  path: string,
  dataRoot: string,
  lockDirectory: string,
  reason: DataRootInstanceLockInvalidReason,
): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new LockObservationRetryError();
    }
    throw new DataRootInstanceLockInvalidError(
      `The data-root lock path is unreadable: ${formatError(error)}`,
      dataRoot,
      lockDirectory,
      reason,
    );
  }
}

function sameHostname(left: string, right: string): boolean {
  return normalizeHostname(left) === normalizeHostname(right);
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase();
}

function sameOwnerIdentity(
  left: DataRootInstanceLockOwner,
  right: DataRootInstanceLockOwner,
): boolean {
  return (
    left.token === right.token &&
    left.pid === right.pid &&
    sameHostname(left.hostname, right.hostname)
  );
}

function sameReclaimIdentity(left: ReclaimOwner, right: ReclaimOwner): boolean {
  return (
    left.token === right.token &&
    left.pid === right.pid &&
    sameHostname(left.hostname, right.hostname) &&
    left.startedAt === right.startedAt
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    String(error.code) === code
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
