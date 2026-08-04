/* eslint-disable @typescript-eslint/ban-ts-comment -- boundary records are intentionally schema-flexible */
// @ts-nocheck -- JSON/JSONL work-boundary records are validated at runtime.
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

/**
 * Scan explicit JSON/JSONL inputs for work ownership. This intentionally
 * recognizes only the three documented top-level shapes: work_id, workId, and
 * work.id. It never walks nested provenance.
 * @param {string[]} inputPaths
 */
async function scanWorkBoundaries(inputPaths) {
  const files = await resolveWorkBoundaryFiles(inputPaths);
  const boundary = {
    workIds: new Set(),
    files: [],
    recordsRead: 0,
  };
  for (const filePath of files) {
    const stat = await fsp.stat(filePath);
    const fileSummary = {
      path: path.resolve(filePath),
      sizeBytes: stat.size,
      sha256: await sha256File(filePath),
      recordsRead: 0,
    };
    if (filePath.toLowerCase().endsWith(".jsonl")) {
      const input = fs.createReadStream(filePath, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        collectWorkBoundaryRecord(JSON.parse(line), boundary);
        fileSummary.recordsRead += 1;
      }
    } else {
      const payload = JSON.parse(await fsp.readFile(filePath, "utf8"));
      const records = Array.isArray(payload) ? payload : [payload];
      for (const record of records) {
        collectWorkBoundaryRecord(record, boundary);
        fileSummary.recordsRead += 1;
      }
    }
    boundary.recordsRead += fileSummary.recordsRead;
    boundary.files.push(fileSummary);
  }
  return boundary;
}

/** @param {string[]} inputs */
async function resolveWorkBoundaryFiles(inputs) {
  const files = [];
  for (const supplied of inputs) {
    const resolved = path.resolve(supplied);
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new Error(`Work boundary input does not exist: ${resolved}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (stat.isFile()) {
      if (!/\.jsonl?$/i.test(resolved)) {
        throw new Error(
          `Work boundary input must be JSON or JSONL: ${resolved}`,
        );
      }
      files.push(resolved);
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `Work boundary input is not a file or directory: ${resolved}`,
      );
    }
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.jsonl?$/i.test(entry.name)) {
        files.push(path.join(resolved, entry.name));
      }
    }
  }
  const resolvedFiles = [...new Set(files)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (inputs.length > 0 && resolvedFiles.length === 0) {
    throw new Error("Work boundary inputs contain no JSON or JSONL files");
  }
  return resolvedFiles;
}

/** @param {unknown} value @param {{ workIds: Set<string> }} boundary */
function collectWorkBoundaryRecord(value, boundary) {
  const record = asRecord(value);
  if (!record) return;
  const work = asRecord(record.work);
  for (const candidate of [record.work_id, record.workId, work?.id]) {
    if (typeof candidate !== "string") continue;
    const workId = candidate.trim();
    if (workId) boundary.workIds.add(workId);
  }
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

/** @param {string} filePath */
async function sha256File(filePath) {
  const hash = nodeCrypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

module.exports = { scanWorkBoundaries };
