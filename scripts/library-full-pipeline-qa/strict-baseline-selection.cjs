/* eslint-disable @typescript-eslint/ban-ts-comment -- QA manifests intentionally span multiple schema generations */
// @ts-nocheck -- runtime validation below owns the schema-flexible boundary contract.
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const {
  normalizeRelativePath,
  sha256,
  sha256File,
} = require("./selection.cjs");

const SOURCE_HASH_KEYS = [
  "source_page_sha256",
  "sourcePageSha256",
  "page_sha256",
  "pageSha256",
  "imageSha256",
  "image_sha256",
];
const PAGE_ID_KEYS = [
  "page_id",
  "pageId",
  "source_page_id",
  "sourcePageId",
  "library_page_id",
  "libraryPageId",
];

function createSourceBoundary() {
  return {
    pageIds: new Set(),
    relativePaths: new Set(),
    sourcePageSha256s: new Set(),
    referencedWorkIds: new Set(),
    files: [],
    recordsRead: 0,
  };
}

/** @param {Array<{ category: string; paths: string[] }>} groups */
async function scanStrictSourceBoundaries(groups) {
  const boundary = createSourceBoundary();
  const seen = new Set();
  for (const group of groups) {
    if (!group || typeof group.category !== "string") {
      throw new Error("Every source-boundary group needs a category");
    }
    for (const supplied of group.paths || []) {
      assertNotCurrentV10Holdout(supplied);
      const filePath = path.resolve(supplied);
      if (seen.has(filePath)) {
        throw new Error(`Duplicate source-boundary file: ${filePath}`);
      }
      seen.add(filePath);
      const summary = await scanSourceBoundaryFile(filePath, boundary);
      boundary.files.push({ category: group.category, ...summary });
    }
  }
  boundary.files.sort((left, right) => left.path.localeCompare(right.path));
  return boundary;
}

/** @param {string} supplied */
function assertNotCurrentV10Holdout(supplied) {
  const normalized = path.resolve(supplied).replace(/\\/g, "/").toLowerCase();
  if (
    normalized.includes(
      "/artifacts/library-full-pipeline-font-qa-v10/cohorts/holdout40.jsonl",
    ) ||
    normalized.includes(
      "/artifacts/library-full-pipeline-font-qa-v10/runs/holdout40/",
    )
  ) {
    throw new Error(`Current v10 holdout is forbidden input: ${supplied}`);
  }
}

/** @param {string} filePath @param {ReturnType<typeof createSourceBoundary>} boundary */
async function scanSourceBoundaryFile(filePath, boundary) {
  if (!/\.jsonl?$/i.test(filePath)) {
    throw new Error(`Source-boundary input must be JSON or JSONL: ${filePath}`);
  }
  const stat = await fsp.stat(filePath);
  if (!stat.isFile())
    throw new Error(`Source-boundary input is not a file: ${filePath}`);
  const before = boundaryCounts(boundary);
  let recordsRead = 0;
  if (/\.jsonl$/i.test(filePath)) {
    const lines = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      collectSourcePageIdentities(JSON.parse(line), boundary);
      recordsRead += 1;
    }
  } else {
    const payload = JSON.parse(await fsp.readFile(filePath, "utf8"));
    const records = Array.isArray(payload) ? payload : [payload];
    for (const record of records) collectSourcePageIdentities(record, boundary);
    recordsRead = records.length;
  }
  boundary.recordsRead += recordsRead;
  const after = boundaryCounts(boundary);
  return {
    path: filePath,
    sizeBytes: stat.size,
    sha256: await sha256File(filePath),
    recordsRead,
    addedPageIds: after.pageIds - before.pageIds,
    addedRelativePaths: after.relativePaths - before.relativePaths,
    addedSourcePageSha256s: after.sourcePageSha256s - before.sourcePageSha256s,
  };
}

/** @param {unknown} value @param {ReturnType<typeof createSourceBoundary>} boundary */
function collectSourcePageIdentities(value, boundary) {
  if (Array.isArray(value)) {
    for (const item of value) collectSourcePageIdentities(item, boundary);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const page = asRecord(record.page);
  const work = asRecord(record.work);
  for (const key of PAGE_ID_KEYS) addString(boundary.pageIds, record[key]);
  for (const key of ["work_id", "workId"]) {
    addString(boundary.referencedWorkIds, record[key]);
  }
  addString(boundary.referencedWorkIds, work?.id);
  if (page) {
    addString(boundary.pageIds, page.id);
    for (const key of ["imageRelativePath", "image_relative_path"]) {
      addBoundaryPath(boundary.relativePaths, page[key]);
    }
    for (const key of ["imagePath", "image_path"]) {
      addBoundaryPath(boundary.relativePaths, page[key]);
    }
    for (const key of SOURCE_HASH_KEYS) {
      addSha256(boundary.sourcePageSha256s, page[key]);
    }
  }
  for (const key of SOURCE_HASH_KEYS) {
    addSha256(boundary.sourcePageSha256s, record[key]);
  }
  for (const locator of [
    record.source_locator,
    record.sourceLocator,
    page?.source_locator,
    page?.sourceLocator,
  ]) {
    collectSourceLocator(locator, boundary);
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") {
      collectSourcePageIdentities(nested, boundary);
    }
  }
}

/** @param {unknown} value @param {ReturnType<typeof createSourceBoundary>} boundary */
function collectSourceLocator(value, boundary) {
  const locator = asRecord(value);
  if (!locator) return;
  for (const key of ["path", "relative_path", "image_path"]) {
    addBoundaryPath(boundary.relativePaths, locator[key]);
  }
  for (const key of ["file_sha256", "sha256", "source_page_sha256"]) {
    addSha256(boundary.sourcePageSha256s, locator[key]);
  }
}

/** @param {string} manifestPath */
async function scanMasterWorkUnion(manifestPath) {
  const resolved = path.resolve(manifestPath);
  if (!/\.jsonl$/i.test(resolved)) {
    throw new Error(`Master work boundary must be JSONL: ${resolved}`);
  }
  const stat = await fsp.stat(resolved);
  const works = new Map();
  const splitRows = { train: 0, val: 0, test: 0 };
  let recordsRead = 0;
  const lines = readline.createInterface({
    input: fs.createReadStream(resolved, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const record = JSON.parse(line);
    const work = asRecord(record.work);
    const chapter = asRecord(record.chapter);
    const page = asRecord(record.page);
    const workId = requiredString(
      work?.id,
      `record ${recordsRead + 1} work.id`,
    );
    const split = requiredString(
      record.split,
      `record ${recordsRead + 1} split`,
    );
    if (!Object.hasOwn(splitRows, split)) {
      throw new Error(`Unexpected master-v3 split: ${split}`);
    }
    let entry = works.get(workId);
    if (!entry) {
      entry = {
        id: workId,
        title: String(work?.title || workId),
        rows: 0,
        splitRows: { train: 0, val: 0, test: 0 },
        pageIds: new Set(),
        chapterIds: new Set(),
      };
      works.set(workId, entry);
    }
    entry.rows += 1;
    entry.splitRows[split] += 1;
    splitRows[split] += 1;
    addString(entry.pageIds, page?.id);
    addString(entry.chapterIds, chapter?.id);
    recordsRead += 1;
  }
  return {
    workIds: new Set(works.keys()),
    works,
    recordsRead,
    splitRows,
    file: {
      path: resolved,
      sizeBytes: stat.size,
      sha256: await sha256File(resolved),
      recordsRead,
    },
  };
}

/** @param {any[]} candidates @param {{ workIds: Set<string> }} workBoundary @param {ReturnType<typeof createSourceBoundary>} sourceBoundary */
function excludeStrictIdentityOverlap(
  candidates,
  workBoundary,
  sourceBoundary,
) {
  const afterWork = candidates.filter(
    (candidate) => !workBoundary.workIds.has(candidate.workId),
  );
  const eligible = afterWork.filter(
    (candidate) =>
      !sourceBoundary.pageIds.has(candidate.pageId) &&
      !sourceBoundary.relativePaths.has(candidate.imageRelativePath),
  );
  return { afterWork, eligible };
}

/** @param {any[]} candidates @param {Set<string>} forbiddenSha256s @param {number} [concurrency] */
async function excludeStrictShaOverlap(
  candidates,
  forbiddenSha256s,
  concurrency = 8,
) {
  const acceptedByIndex = new Array(candidates.length);
  const fileHashCache = new Map();
  let excludedBySha = 0;
  let nextIndex = 0;
  const workerCount = Math.min(
    Math.max(1, concurrency),
    candidates.length || 1,
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < candidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        const candidate = candidates[index];
        if (!candidate) continue;
        const imagePath = path.resolve(candidate.imagePath);
        const digest = await sha256File(imagePath);
        fileHashCache.set(imagePath, digest);
        if (forbiddenSha256s.has(digest)) excludedBySha += 1;
        else acceptedByIndex[index] = candidate;
      }
    }),
  );
  return {
    candidates: acceptedByIndex.filter(Boolean),
    excludedBySha,
    fileHashCache,
  };
}

/** @param {any[]} candidates @param {{ seed: string; target: number; maxPagesPerWork: number }} options */
function selectStrictBaseline(candidates, options) {
  const target = positiveInteger(options.target, "target");
  const maxPagesPerWork = positiveInteger(
    options.maxPagesPerWork,
    "maxPagesPerWork",
  );
  const states = buildWorkStates(candidates, options.seed);
  const selected = [];
  const usedPages = new Set();
  const usedChapters = new Set();
  for (const state of states) {
    if (selected.length >= target) break;
    pickFromWork(state, true, selected, usedPages, usedChapters, options.seed);
  }
  fillRoundRobin({
    states,
    target,
    maxPagesPerWork,
    requireNewChapter: true,
    selected,
    usedPages,
    usedChapters,
    seed: options.seed,
  });
  fillRoundRobin({
    states,
    target,
    maxPagesPerWork,
    requireNewChapter: false,
    selected,
    usedPages,
    usedChapters,
    seed: options.seed,
  });
  if (selected.length !== target) {
    throw new Error(
      `Strict baseline capacity is ${selected.length}, below requested ${target}`,
    );
  }
  return selected;
}

/** @param {any[]} candidates @param {string} seed */
function buildWorkStates(candidates, seed) {
  const byWork = new Map();
  for (const candidate of candidates) {
    let state = byWork.get(candidate.workId);
    if (!state) {
      state = {
        workId: candidate.workId,
        selectedCount: 0,
        chapters: new Map(),
      };
      byWork.set(candidate.workId, state);
    }
    const key = chapterKey(candidate);
    const pages = state.chapters.get(key) || [];
    pages.push(candidate);
    state.chapters.set(key, pages);
  }
  for (const state of byWork.values()) {
    for (const pages of state.chapters.values()) {
      pages.sort((left, right) => compareCandidates(left, right, seed));
    }
  }
  return [...byWork.values()].sort((left, right) =>
    stableRank(seed, `work:${left.workId}`).localeCompare(
      stableRank(seed, `work:${right.workId}`),
    ),
  );
}

/** @param {any} input */
function fillRoundRobin(input) {
  let progressed = true;
  while (input.selected.length < input.target && progressed) {
    progressed = false;
    for (const state of input.states) {
      if (input.selected.length >= input.target) break;
      if (state.selectedCount >= input.maxPagesPerWork) continue;
      if (
        pickFromWork(
          state,
          input.requireNewChapter,
          input.selected,
          input.usedPages,
          input.usedChapters,
          input.seed,
        )
      ) {
        progressed = true;
      }
    }
  }
}

/** @param {any} state @param {boolean} requireNewChapter @param {any[]} selected @param {Set<string>} usedPages @param {Set<string>} usedChapters @param {string} seed */
function pickFromWork(
  state,
  requireNewChapter,
  selected,
  usedPages,
  usedChapters,
  seed,
) {
  const choices = [];
  for (const [key, pages] of state.chapters) {
    if (requireNewChapter && usedChapters.has(key)) continue;
    const page = pages.find((candidate) => !usedPages.has(candidate.pageId));
    if (page) choices.push(page);
  }
  choices.sort((left, right) => compareCandidates(left, right, seed));
  const picked = choices[0];
  if (!picked) return false;
  selected.push(picked);
  usedPages.add(picked.pageId);
  usedChapters.add(chapterKey(picked));
  state.selectedCount += 1;
  return true;
}

/** @param {any} left @param {any} right @param {string} seed */
function compareCandidates(left, right, seed) {
  const leftStrong = Number(left.variantSignals?.strongTotal || 0);
  const rightStrong = Number(right.variantSignals?.strongTotal || 0);
  if (rightStrong > 0 !== leftStrong > 0) return rightStrong > 0 ? 1 : -1;
  if (rightStrong !== leftStrong) return rightStrong - leftStrong;
  const signalDelta =
    Number(right.variantSignalCount || 0) -
    Number(left.variantSignalCount || 0);
  if (signalDelta) return signalDelta;
  return stableRank(seed, `page:${left.pageId}`).localeCompare(
    stableRank(seed, `page:${right.pageId}`),
  );
}

/** @param {any[]} records @param {{ target: number; maxPagesPerWork: number; workIds: Set<string>; sourceBoundary: ReturnType<typeof createSourceBoundary> }} contract */
// eslint-disable-next-line complexity -- each independent overlap dimension is reported separately.
function validateStrictBaselineRecords(records, contract) {
  const errors = [];
  const pages = new Set();
  const chapters = new Set();
  const workCounts = new Map();
  for (const record of records) {
    const workId = String(record.work?.id || "");
    const pageId = String(record.page?.id || "");
    const relativePath = normalizeRelativePath(record.page?.imageRelativePath);
    const digest = String(record.page?.imageSha256 || "").toLowerCase();
    if (!pageId || pages.has(pageId))
      errors.push(`duplicate/missing page: ${pageId}`);
    pages.add(pageId);
    chapters.add(`${workId}\0${String(record.chapter?.id || "")}`);
    workCounts.set(workId, (workCounts.get(workId) || 0) + 1);
    if (contract.workIds.has(workId))
      errors.push(`master work overlap: ${workId}`);
    if (contract.sourceBoundary.pageIds.has(pageId))
      errors.push(`page-id overlap: ${pageId}`);
    if (contract.sourceBoundary.relativePaths.has(relativePath)) {
      errors.push(`page-path overlap: ${relativePath}`);
    }
    if (contract.sourceBoundary.sourcePageSha256s.has(digest)) {
      errors.push(`page-sha overlap: ${digest}`);
    }
  }
  if (records.length !== contract.target) {
    errors.push(`expected ${contract.target} pages, got ${records.length}`);
  }
  for (const [workId, count] of workCounts) {
    if (count > contract.maxPagesPerWork) {
      errors.push(`work ${workId} has ${count} pages`);
    }
  }
  return {
    errors,
    pages: pages.size,
    works: workCounts.size,
    chapters: chapters.size,
    maximumPagesPerWork: Math.max(0, ...workCounts.values()),
  };
}

/** @param {ReturnType<typeof createSourceBoundary>} boundary */
function serializeSourceBoundary(boundary) {
  return {
    schemaVersion: 1,
    pageIds: [...boundary.pageIds].sort(),
    relativePaths: [...boundary.relativePaths].sort(),
    sourcePageSha256s: [...boundary.sourcePageSha256s].sort(),
  };
}

/** @param {Awaited<ReturnType<typeof scanMasterWorkUnion>>} boundary */
function serializeMasterWorkUnion(boundary) {
  return [...boundary.works.values()]
    .map((work) => ({
      schemaVersion: 1,
      work: { id: work.id, title: work.title },
      splitRows: work.splitRows,
      rows: work.rows,
      sourcePages: work.pageIds.size,
      chapters: work.chapterIds.size,
    }))
    .sort((left, right) => left.work.id.localeCompare(right.work.id));
}

function boundaryFilesBindingSha256(files) {
  return sha256(
    files
      .map((file) => `${file.category || "master"}:${file.path}:${file.sha256}`)
      .sort()
      .join("\n"),
  );
}

function boundaryCounts(boundary) {
  return {
    pageIds: boundary.pageIds.size,
    relativePaths: boundary.relativePaths.size,
    sourcePageSha256s: boundary.sourcePageSha256s.size,
  };
}

function chapterKey(candidate) {
  return `${candidate.workId}\0${candidate.chapterId}`;
}

function stableRank(seed, value) {
  return nodeCrypto
    .createHash("sha256")
    .update(`${seed}\0${value}`)
    .digest("hex");
}

function addBoundaryPath(target, value) {
  if (typeof value !== "string" || !value.trim()) return;
  const normalized = value.replace(/\\/g, "/");
  const marker = normalized.toLowerCase().lastIndexOf("/library/");
  target.add(
    normalizeRelativePath(
      marker >= 0 ? normalized.slice(marker + 9) : normalized,
    ),
  );
}

function addString(target, value) {
  if (typeof value === "string" && value.trim()) target.add(value.trim());
}

function addSha256(target, value) {
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) {
    target.add(value.toLowerCase());
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${label}`);
  return value.trim();
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be positive`);
  return parsed;
}

module.exports = {
  assertNotCurrentV10Holdout,
  boundaryCounts,
  boundaryFilesBindingSha256,
  collectSourcePageIdentities,
  excludeStrictIdentityOverlap,
  excludeStrictShaOverlap,
  scanMasterWorkUnion,
  scanStrictSourceBoundaries,
  selectStrictBaseline,
  serializeMasterWorkUnion,
  serializeSourceBoundary,
  validateStrictBaselineRecords,
};
