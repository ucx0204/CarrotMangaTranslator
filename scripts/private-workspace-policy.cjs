const FORBIDDEN_ROOT_DIRECTORIES = Object.freeze([
  ".claude",
  ".bug-hunter",
  ".impeccable",
  ".codex-workspace",
  ".pytest_cache",
  ".ruff_cache",
  ".settings-pairs",
  "codex",
  "cache",
  "external-image-copies",
  "font-chapter-c18",
  "fonts",
  "library",
  "logs",
  "results",
  "testProject1",
]);

const FORBIDDEN_ROOT_FILES = Object.freeze([
  "block-library.json",
  "batch-edit-schemes.yaml",
  "image-redactions.json",
  "linked-sync-queue.json",
  "linked-workspaces.json",
  "panel-window-bounds.json",
  "recent-dialog-paths.json",
  "settings.commit.json",
  "settings.json",
  "settings.secrets.json",
]);

const FORBIDDEN_ROOT_PREFIXES = Object.freeze([
  ".linked-sync-queue.json.",
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

/** Only compiled code, its dependencies and distribution notices enter ASAR.
 * @param {string} value
 */
function isPackagedAppPath(value) {
  const normalized = normalizeRepositoryPath(value);
  const root = normalized.split("/", 1)[0];
  return (
    ["out", "node_modules", "third_party"].includes(root) ||
    ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"].includes(normalized)
  );
}

module.exports = {
  FORBIDDEN_GITHUB_PATH_PATTERNS,
  FORBIDDEN_ROOT_DIRECTORIES,
  FORBIDDEN_ROOT_FILES,
  FORBIDDEN_ROOT_PREFIXES,
  isForbiddenRepositoryPath,
  isPackagedAppPath,
  normalizeRepositoryPath,
};
