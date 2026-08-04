/* eslint-disable @typescript-eslint/ban-ts-comment -- this QA tool consumes schema-flexible library fixtures */
// @ts-nocheck -- fixture-selection records are intentionally schema-flexible across library generations.
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { selectQaCohorts } = require("./cohort-selection.cjs");
const { scanWorkBoundaries } = require("./work-boundary.cjs");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VARIANT_ROLES = new Set([
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
  "other",
]);

/** @param {string} value */
function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^library\//i, "")
    .toLowerCase();
}

/** @param {string | Buffer} value */
function sha256(value) {
  return nodeCrypto.createHash("sha256").update(value).digest("hex");
}

/** @param {string} filePath */
async function sha256File(filePath) {
  const hash = nodeCrypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/**
 * Scan explicit dataset/export manifests for source-page ownership. The scan
 * deliberately reads only JSON/JSONL inputs supplied by the caller; image
 * folders and arbitrary artifacts are never traversed as data.
 * @param {string[]} inputPaths
 */
async function scanTrainingBoundaries(inputPaths) {
  const files = await resolveBoundaryFiles(inputPaths);
  const boundary = {
    pageIds: new Set(),
    relativePaths: new Set(),
    sourcePageSha256s: new Set(),
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
        collectBoundaryRecord(JSON.parse(line), boundary);
        fileSummary.recordsRead += 1;
      }
    } else {
      const payload = JSON.parse(await fsp.readFile(filePath, "utf8"));
      const records = Array.isArray(payload) ? payload : [payload];
      for (const record of records) {
        collectBoundaryRecord(record, boundary);
        fileSummary.recordsRead += 1;
      }
    }
    boundary.recordsRead += fileSummary.recordsRead;
    boundary.files.push(fileSummary);
  }
  return boundary;
}

/** @param {string[]} inputs */
async function resolveBoundaryFiles(inputs) {
  const files = [];
  for (const supplied of inputs) {
    const resolved = path.resolve(supplied);
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isFile() && /\.jsonl?$/i.test(resolved)) {
      files.push(resolved);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        /(?:manifest|master|resolved-labels|finals|train|val|test).*\.jsonl?$/i.test(
          entry.name,
        )
      ) {
        files.push(path.join(resolved, entry.name));
      }
    }
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

/** @param {unknown} value @param {Awaited<ReturnType<typeof scanTrainingBoundaries>>} boundary */
function collectBoundaryRecord(value, boundary) {
  const record = asRecord(value);
  if (!record) return;
  const page = asRecord(record.page);
  if (typeof page?.id === "string") boundary.pageIds.add(page.id);
  if (typeof page?.imageRelativePath === "string") {
    boundary.relativePaths.add(normalizeRelativePath(page.imageRelativePath));
  }
  collectLocator(page?.source_locator, boundary);
  collectLocator(record.source_locator, boundary);
  collectLocator(record.sourcePage, boundary);
  for (const key of [
    "source_page_sha256",
    "page_sha256",
    "sourcePageSha256",
    "imageSha256",
  ]) {
    const candidate = record[key] ?? page?.[key];
    if (typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate)) {
      boundary.sourcePageSha256s.add(candidate.toLowerCase());
    }
  }
}

/** @param {unknown} value @param {Awaited<ReturnType<typeof scanTrainingBoundaries>>} boundary */
function collectLocator(value, boundary) {
  const locator = asRecord(value);
  if (!locator) return;
  for (const key of ["path", "relative_path", "image_path"]) {
    if (typeof locator[key] === "string") {
      boundary.relativePaths.add(normalizeRelativePath(locator[key]));
    }
  }
  for (const key of ["file_sha256", "sha256", "source_page_sha256"]) {
    const candidate = locator[key];
    if (typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate)) {
      boundary.sourcePageSha256s.add(candidate.toLowerCase());
    }
  }
}

/** @param {string} libraryRoot */
async function readLibraryCandidates(libraryRoot) {
  const root = path.resolve(libraryRoot);
  const index = JSON.parse(
    await fsp.readFile(path.join(root, "index.json"), "utf8"),
  );
  const workOrder = Array.isArray(index.workOrder) ? index.workOrder : [];
  const candidates = [];
  for (const [workIndex, workId] of workOrder.entries()) {
    candidates.push(
      ...(await readWorkCandidates(root, String(workId), workIndex)),
    );
  }
  return candidates;
}

/** @param {string} root @param {string} workId @param {number} workIndex */
async function readWorkCandidates(root, workId, workIndex) {
  const workDir = path.join(root, "works", workId);
  const work = JSON.parse(
    await fsp.readFile(path.join(workDir, "work.json"), "utf8"),
  );
  const chapterOrder = Array.isArray(work.chapterOrder)
    ? work.chapterOrder
    : [];
  const candidates = [];
  for (const [chapterIndex, chapterId] of chapterOrder.entries()) {
    candidates.push(
      ...(await readChapterCandidates({
        chapterId: String(chapterId),
        chapterIndex,
        root,
        work,
        workDir,
        workIndex,
      })),
    );
  }
  return candidates;
}

/** @param {{ chapterId: string; chapterIndex: number; root: string; work: any; workDir: string; workIndex: number }} input */
async function readChapterCandidates(input) {
  const chapterPath = path.join(
    input.workDir,
    "chapters",
    input.chapterId,
    "chapter.json",
  );
  const chapter = await readOptionalJson(chapterPath);
  if (!chapter) return [];
  const pagesById = new Map(
    (Array.isArray(chapter.pages) ? chapter.pages : []).map((page) => [
      page.id,
      page,
    ]),
  );
  const pageOrder = Array.isArray(chapter.pageOrder)
    ? chapter.pageOrder
    : [...pagesById.keys()];
  const candidates = [];
  for (const [pageIndex, pageId] of pageOrder.entries()) {
    const candidate = await toLibraryCandidate(
      pagesById.get(pageId),
      pageIndex,
      chapter,
      chapterPath,
      input,
    );
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/** @param {any} page @param {number} pageIndex @param {any} chapter @param {string} chapterPath @param {{ chapterIndex: number; root: string; work: any; workIndex: number }} input */
async function toLibraryCandidate(
  page,
  pageIndex,
  chapter,
  chapterPath,
  input,
) {
  if (!page || typeof page.imagePath !== "string") return null;
  const imagePath = path.resolve(page.imagePath);
  if (!isPathInside(input.root, imagePath) || !isOriginalPageImage(imagePath)) {
    return null;
  }
  const stat = await statOptionalFile(imagePath);
  if (!stat) return null;
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  const variantSignals = countVariantSignals(blocks);
  return {
    workId: String(input.work.id),
    workTitle: String(input.work.title || input.work.id),
    workIndex: input.workIndex,
    chapterId: String(chapter.id),
    chapterTitle: String(chapter.title || chapter.id),
    chapterIndex: input.chapterIndex,
    chapterJsonPath: chapterPath,
    pageId: String(page.id),
    pageName: String(page.name || path.basename(imagePath)),
    pageIndex,
    imagePath,
    imageRelativePath: normalizeRelativePath(
      path.relative(input.root, imagePath),
    ),
    imageSizeBytes: stat.size,
    width: Number(page.width) || 0,
    height: Number(page.height) || 0,
    blockCount: blocks.length,
    variantSignalCount: variantSignals.total,
    variantSignals,
  };
}

/** @param {string} filePath */
async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} filePath */
async function statOptionalFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {any[]} blocks */
function countVariantSignals(blocks) {
  let semantic = 0;
  let sound = 0;
  let sfxType = 0;
  let rotated = 0;
  let handwrittenLike = 0;
  let geometryProxy = 0;
  for (const block of blocks) {
    if (VARIANT_ROLES.has(String(block.fontRole || ""))) semantic += 1;
    if (block.textRole === "sound") sound += 1;
    // Older library chapters predate textRole/fontRole persistence, but their
    // detector-owned block type still distinguishes effects from dialogue.
    if (String(block.type || "").toLowerCase() === "sfx") sfxType += 1;
    if (Math.abs(Number(block.rotationDeg) || 0) >= 5) rotated += 1;
    if (
      /brush|gaegu|gugi|kirang|single-day|gasoek|start-over/i.test(
        String(block.fontFamily || ""),
      )
    ) {
      handwrittenLike += 1;
    }
    if (isExpressiveGeometryProxy(block)) geometryProxy += 1;
  }
  const strongTotal = semantic + sound + sfxType + rotated + handwrittenLike;
  return {
    semantic,
    sound,
    sfxType,
    rotated,
    handwrittenLike,
    geometryProxy,
    strongTotal,
    total: strongTotal + geometryProxy,
  };
}

/**
 * OCR-free detector geometry proxy for text outside ordinary speech blocks.
 * It uses only normalized boxes and detector type; no pixels or text content
 * are surfaced to the selector or reviewer.
 * @param {any} block
 */
function isExpressiveGeometryProxy(block) {
  const type = String(block.type || "").toLowerCase();
  if (!["nonsolid", "caption", "other"].includes(type)) return false;
  const bbox = asRecord(block.bbox);
  if (!bbox || block.bboxSpace !== "normalized_1000") return false;
  const x = Number(bbox.x) || 0;
  const y = Number(bbox.y) || 0;
  const width = Number(bbox.w) || 0;
  const height = Number(bbox.h) || 0;
  if (width <= 0 || height <= 0) return false;
  const aspect = Math.max(width / height, height / width);
  const area = width * height;
  const touchesPageEdge =
    x < 40 || y < 40 || x + width > 960 || y + height > 960;
  return (
    type === "caption" ||
    aspect >= 4.5 ||
    area >= 70_000 ||
    (touchesPageEdge && aspect >= 2.5)
  );
}

/** @param {string} root @param {string} target */
function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** @param {string} filePath */
function isOriginalPageImage(filePath) {
  if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  const segments = filePath.split(/[\\/]+/).map((entry) => entry.toLowerCase());
  return !segments.some((entry) =>
    ["inpainted", "translated", "outputs", "runs"].includes(entry),
  );
}

/**
 * @param {Awaited<ReturnType<typeof readLibraryCandidates>>} candidates
 * @param {Awaited<ReturnType<typeof scanTrainingBoundaries>>} boundary
 */
function excludeTrainingOverlap(candidates, boundary) {
  return candidates.filter(
    (candidate) =>
      !boundary.pageIds.has(candidate.pageId) &&
      !boundary.relativePaths.has(candidate.imageRelativePath),
  );
}

/**
 * @param {Awaited<ReturnType<typeof readLibraryCandidates>>} candidates
 * @param {Awaited<ReturnType<typeof scanWorkBoundaries>>} boundary
 */
function excludeWorkBoundaryOverlap(candidates, boundary) {
  return candidates.filter(
    (candidate) => !boundary.workIds.has(candidate.workId),
  );
}

/**
 * Materialize hashes only after selection, avoiding a 6,000-page hashing pass.
 * @param {any[]} selected
 * @param {"baseline40" | "holdout40"} cohort
 */
async function materializeCohort(selected, cohort, fileHashCache = new Map()) {
  const records = [];
  for (const [selectionIndex, item] of selected.entries()) {
    records.push({
      schemaVersion: 1,
      cohort,
      selectionIndex,
      work: { id: item.workId, title: item.workTitle, index: item.workIndex },
      chapter: {
        id: item.chapterId,
        title: item.chapterTitle,
        index: item.chapterIndex,
        jsonPath: path.resolve(item.chapterJsonPath),
        jsonSha256: await cachedSha256File(item.chapterJsonPath, fileHashCache),
      },
      page: {
        id: item.pageId,
        name: item.pageName,
        index: item.pageIndex,
        imagePath: path.resolve(item.imagePath),
        imageRelativePath: item.imageRelativePath,
        imageSha256: await cachedSha256File(item.imagePath, fileHashCache),
        imageSizeBytes: item.imageSizeBytes,
        width: item.width,
        height: item.height,
        existingBlockCount: item.blockCount,
        variantSignalCount: item.variantSignalCount,
        variantSignals: item.variantSignals,
      },
      inferenceBoundary: {
        source: "user_page",
        datasetSplit: null,
        qaOverlay: false,
      },
    });
  }
  return records;
}

/** @param {string} filePath @param {Map<string, string>} cache */
async function cachedSha256File(filePath, cache) {
  const resolved = path.resolve(filePath);
  const cached = cache.get(resolved);
  if (cached) return cached;
  const digest = await sha256File(resolved);
  cache.set(resolved, digest);
  return digest;
}

/** @param {any[]} records */
function cohortDigest(records) {
  return sha256(
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}

/** @param {any[]} records */
function summarizeCohort(records) {
  const works = new Map();
  const chapters = new Set();
  let variants = 0;
  let strongVariants = 0;
  let geometryProxyOnly = 0;
  let blocks = 0;
  for (const record of records) {
    works.set(record.work.id, (works.get(record.work.id) || 0) + 1);
    chapters.add(record.chapter.id);
    if (record.page.variantSignalCount > 0) variants += 1;
    if ((record.page.variantSignals.strongTotal || 0) > 0) strongVariants += 1;
    else if ((record.page.variantSignals.geometryProxy || 0) > 0) {
      geometryProxyOnly += 1;
    }
    blocks += record.page.existingBlockCount;
  }
  return {
    pages: records.length,
    works: works.size,
    chapters: chapters.size,
    maximumPagesPerWork: Math.max(0, ...works.values()),
    pagesWithVariantSignals: variants,
    pagesWithStrongVariantSignals: strongVariants,
    pagesWithGeometryProxyOnly: geometryProxyOnly,
    existingBlocks: blocks,
  };
}

module.exports = {
  cohortDigest,
  excludeTrainingOverlap,
  excludeWorkBoundaryOverlap,
  materializeCohort,
  normalizeRelativePath,
  readLibraryCandidates,
  scanTrainingBoundaries,
  scanWorkBoundaries,
  selectQaCohorts,
  sha256,
  sha256File,
  summarizeCohort,
};
