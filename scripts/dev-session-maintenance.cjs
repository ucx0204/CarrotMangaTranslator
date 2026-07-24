// @ts-check
const {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} = require("node:fs");
const {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require("node:path");

const DEV_STORAGE_DIRECTORY_NAME = "electron-dev";
const SESSION_DATA_DIRECTORY_NAME = "session-data";
const LEGACY_SESSION_NAME = /^session-\d+-\d+$/;
const MAX_DELETE_RETRIES = 4;
const DELETE_RETRY_DELAY_MS = 50;
const RETRYABLE_DELETE_ERRORS = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);
const deleteRetrySignal = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

/**
 * @typedef {{
 *   path: string,
 *   entries: string[] | null,
 *   nextEntryIndex: number,
 * }} DirectoryFrame
 */

/**
 * Remove only the process-scoped profile directories created by older
 * versions of scripts/dev.cjs. Persistent user-data and every non-matching
 * sibling are deliberately outside this cleanup contract.
 *
 * @param {string} storageRoot
 * @returns {{ removedDirectories: number }}
 */
function pruneLegacyDevSessions(storageRoot) {
  const resolvedRoot = resolveDevStorageRoot(storageRoot);
  if (!existsSync(resolvedRoot)) {
    return { removedDirectories: 0 };
  }
  let removedDirectories = 0;
  for (const entry of readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LEGACY_SESSION_NAME.test(entry.name)) {
      continue;
    }
    const target = resolve(resolvedRoot, entry.name);
    assertDirectChild(resolvedRoot, target);
    removeTreeIteratively(target);
    removedDirectories += 1;
  }
  return { removedDirectories };
}

/**
 * Reset only the disposable Chromium session-data child of electron-dev.
 * The target is derived here so callers cannot supply user-data or another
 * arbitrary directory with a similar basename.
 *
 * @param {string} storageRoot
 */
function resetDevSessionData(storageRoot) {
  const resolvedRoot = resolveDevStorageRoot(storageRoot);
  const target = resolve(resolvedRoot, SESSION_DATA_DIRECTORY_NAME);
  assertDirectChild(resolvedRoot, target);
  removeTreeIteratively(target);
}

/**
 * Delete a tree without Node's recursive fs removal implementation. Keeping
 * traversal state on the heap avoids native/JS recursion limits on large
 * Chromium cache trees. lstat ensures links and Windows junctions are removed
 * as leaves instead of following them outside the disposable session.
 *
 * @param {string} target
 */
function removeTreeIteratively(target) {
  const targetStats = lstatIfPresent(target);
  if (!targetStats) {
    return;
  }
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    removeLeaf(target);
    return;
  }

  /** @type {DirectoryFrame[]} */
  const frames = [{ path: target, entries: null, nextEntryIndex: 0 }];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.entries === null) {
      frame.entries = readdirSync(frame.path);
    }
    if (frame.nextEntryIndex >= frame.entries.length) {
      removeEmptyDirectory(frame.path);
      frames.pop();
      continue;
    }

    const childPath = join(
      frame.path,
      frame.entries[frame.nextEntryIndex] ?? "",
    );
    frame.nextEntryIndex += 1;
    const childStats = lstatIfPresent(childPath);
    if (!childStats) {
      continue;
    }
    if (childStats.isDirectory() && !childStats.isSymbolicLink()) {
      frames.push({ path: childPath, entries: null, nextEntryIndex: 0 });
      continue;
    }
    removeLeaf(childPath);
  }
}

/**
 * @param {string} target
 * @returns {import("node:fs").Stats | null}
 */
function lstatIfPresent(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** @param {string} target */
function removeLeaf(target) {
  runDeleteWithRetries(target, () => unlinkSync(target));
}

/** @param {string} target */
function removeEmptyDirectory(target) {
  runDeleteWithRetries(target, () => rmdirSync(target));
}

/**
 * Retry only transient filesystem failures that Windows can report while
 * antivirus/indexing handles have just been released.
 *
 * @param {string} target
 * @param {() => void} remove
 */
function runDeleteWithRetries(target, remove) {
  for (let attempt = 0; attempt <= MAX_DELETE_RETRIES; attempt += 1) {
    try {
      remove();
      return;
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "ENOENT") {
        return;
      }
      if (
        code === null ||
        !RETRYABLE_DELETE_ERRORS.has(code) ||
        attempt === MAX_DELETE_RETRIES
      ) {
        throw error;
      }
      if (code === "EPERM") {
        makeWritable(target, error);
      }
      Atomics.wait(
        deleteRetrySignal,
        0,
        0,
        DELETE_RETRY_DELAY_MS * (attempt + 1),
      );
    }
  }
}

/**
 * @param {string} target
 * @param {unknown} originalError
 */
function makeWritable(target, originalError) {
  try {
    chmodSync(target, 0o700);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return;
    }
    throw new AggregateError(
      [originalError, error],
      `Failed to make a disposable dev-session entry writable: ${target}`,
      { cause: error },
    );
  }
}

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function getErrorCode(error) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return null;
  }
  return error.code;
}

/**
 * @param {string} storageRoot
 * @returns {string}
 */
function resolveDevStorageRoot(storageRoot) {
  const resolvedRoot = resolve(storageRoot);
  if (basename(resolvedRoot) !== DEV_STORAGE_DIRECTORY_NAME) {
    throw new Error(
      `Refusing maintenance outside ${DEV_STORAGE_DIRECTORY_NAME}: ${resolvedRoot}`,
    );
  }
  if (existsSync(resolvedRoot) && lstatSync(resolvedRoot).isSymbolicLink()) {
    throw new Error(
      `Refusing maintenance through a symbolic-link storage root: ${resolvedRoot}`,
    );
  }
  return resolvedRoot;
}

/**
 * @param {string} root
 * @param {string} target
 */
function assertDirectChild(root, target) {
  const child = relative(root, target);
  if (
    !child ||
    child.includes(sep) ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error(`Dev session target escaped its storage root: ${target}`);
  }
}

if (require.main === module) {
  const storageRoot = process.argv[2];
  if (!storageRoot) {
    throw new Error("Usage: node scripts/dev-session-maintenance.cjs <root>");
  }
  const resolvedRoot = resolve(storageRoot);
  if (existsSync(join(resolvedRoot, "dev.lock"))) {
    throw new Error("Refusing cleanup while a development instance is active.");
  }
  const result = pruneLegacyDevSessions(resolvedRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  pruneLegacyDevSessions,
  resetDevSessionData,
};
