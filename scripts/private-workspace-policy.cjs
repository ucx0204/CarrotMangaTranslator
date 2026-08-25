const FORBIDDEN_ROOT_DIRECTORIES = Object.freeze([
  ".claude",
  ".pytest_cache",
  ".ruff_cache",
  ".settings-pairs",
  "fonts",
  "library",
  "logs",
  "results",
  "testProject1",
]);

const FORBIDDEN_ROOT_FILES = Object.freeze([
  "block-library.json",
  "linked-sync-queue.json",
  "linked-workspaces.json",
  "panel-window-bounds.json",
  "recent-dialog-paths.json",
  "settings.commit.json",
  "settings.json",
  "settings.secrets.json",
]);

const FORBIDDEN_ROOT_PREFIXES = Object.freeze([
  ".mgt-instance-candidate-",
  ".mgt-instance-release-",
  ".mgt-instance-stale-",
]);

const FORBIDDEN_GITHUB_PATH_PATTERNS = Object.freeze([
  ...FORBIDDEN_ROOT_DIRECTORIES.flatMap((directory) => [
    directory,
    `${directory}/**/*`,
  ]),
  ...FORBIDDEN_ROOT_FILES,
  ...FORBIDDEN_ROOT_PREFIXES.flatMap((prefix) => [
    `${prefix}*`,
    `${prefix}*/**/*`,
  ]),
  ".mgt-instance-lock",
  ".mgt-instance-lock/**/*",
]);

/** @param {string} value */
function normalizeRepositoryPath(value) {
  return String(value)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

/** @param {string} value */
function isForbiddenRepositoryPath(value) {
  const normalized = normalizeRepositoryPath(value);
  if (!normalized) return false;
  const [rootSegment] = normalized.split("/", 1);
  if (FORBIDDEN_ROOT_FILES.includes(normalized)) return true;
  if (FORBIDDEN_ROOT_DIRECTORIES.includes(rootSegment)) return true;
  if (rootSegment === ".mgt-instance-lock") return true;
  return FORBIDDEN_ROOT_PREFIXES.some((prefix) =>
    rootSegment.startsWith(prefix),
  );
}

module.exports = {
  FORBIDDEN_GITHUB_PATH_PATTERNS,
  FORBIDDEN_ROOT_DIRECTORIES,
  FORBIDDEN_ROOT_FILES,
  FORBIDDEN_ROOT_PREFIXES,
  isForbiddenRepositoryPath,
  normalizeRepositoryPath,
};
