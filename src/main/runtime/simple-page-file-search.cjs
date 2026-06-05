const { existsSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

const { MM_PROJ_CANDIDATE_NAMES } = require("./simple-page-defaults.cjs");

function safeMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function findNamedFile(rootDir, expectedName, maxDepth = 6) {
  if (!rootDir || !existsSync(rootDir)) {
    return null;
  }

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = readdirSync(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name === expectedName) {
        return fullPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function findMatchingFile(rootDir, predicate, maxDepth = 6) {
  if (!rootDir || !existsSync(rootDir)) {
    return null;
  }

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = readdirSync(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && predicate(entry.name, fullPath)) {
        return fullPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function listSnapshotDirs(repoDir) {
  const snapshotsDir = path.join(repoDir, "snapshots");
  if (!existsSync(snapshotsDir)) {
    return [];
  }

  return readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(snapshotsDir, entry.name))
    .sort((left, right) => safeMtimeMs(right) - safeMtimeMs(left) || right.localeCompare(left));
}

function findPreferredMmprojFile(rootDir) {
  for (const candidateName of MM_PROJ_CANDIDATE_NAMES) {
    const match = findNamedFile(rootDir, candidateName, 2);
    if (match) {
      return match;
    }
  }

  return findMatchingFile(rootDir, (name) => /^mmproj.*\.gguf$/i.test(name), 2);
}

module.exports = {
  findMatchingFile,
  findNamedFile,
  findPreferredMmprojFile,
  listSnapshotDirs,
  safeMtimeMs
};
