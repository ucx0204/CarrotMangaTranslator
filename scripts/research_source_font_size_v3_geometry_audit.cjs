#!/usr/bin/env node
/* eslint-disable @typescript-eslint/ban-ts-comment -- this read-only CLI validates versioned artifacts at runtime */
// @ts-nocheck -- versioned read-only research artifacts are validated at runtime.
/* eslint-disable complexity, max-depth -- exhaustive library traversal keeps every artifact boundary visible */
"use strict";

/**
 * Audit persisted library blocks against the current OCR geometry-lock code.
 *
 * Run after `npm run compile:electron` so this script exercises the same
 * compiled production function used by the main process.
 */

const fs = require("node:fs");
const path = require("node:path");
const { applyOcrCandidateGeometryLocks } = loadBuiltModule(
  "out/main/pipeline/overlayOcrGeometryLocks.js",
);

function loadBuiltModule(relativePath) {
  return require(path.join(__dirname, "..", relativePath));
}

function parseArgs(argv) {
  const args = {
    library: path.resolve("library"),
    output: path.resolve(".tmp/source-font-size-v3/geometry-audit.json"),
    excludeLeadingPages: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--library") args.library = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--exclude-leading-pages") {
      args.excludeLeadingPages = Number(argv[++index]);
    } else if (value === "--help") {
      console.log(
        "Usage: node scripts/research_source_font_size_v3_geometry_audit.cjs " +
          "[--library PATH] [--output PATH] [--exclude-leading-pages N]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function listDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function normalizeRawItem(item, requestSummary, page) {
  const bbox = item?.bbox ?? {};
  const coordinateSpace = requestSummary?.bboxCoordinateSpace;
  if (coordinateSpace !== "pixels") {
    return { ...item, bbox: { ...bbox } };
  }
  const frameWidth =
    Number(requestSummary?.bboxCoordinateFrame?.width) || page.width;
  const frameHeight =
    Number(requestSummary?.bboxCoordinateFrame?.height) || page.height;
  return {
    ...item,
    bbox: {
      x: (Number(bbox.x) / frameWidth) * 1000,
      y: (Number(bbox.y) / frameHeight) * 1000,
      w: (Number(bbox.w) / frameWidth) * 1000,
      h: (Number(bbox.h) / frameHeight) * 1000,
    },
  };
}

function toPixels(bbox, page) {
  return {
    x: (Number(bbox?.x) / 1000) * page.width,
    y: (Number(bbox?.y) / 1000) * page.height,
    w: (Number(bbox?.w) / 1000) * page.width,
    h: (Number(bbox?.h) / 1000) * page.height,
  };
}

function bboxArea(bbox) {
  return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function roundedBbox(bbox) {
  return Object.fromEntries(
    Object.entries(bbox).map(([key, value]) => [key, round(value)]),
  );
}

function isCoverLike(page, pageIndex, excludeLeadingPages) {
  if (pageIndex < excludeLeadingPages) return true;
  const label = `${page.name ?? ""} ${page.imagePath ?? ""}`.toLowerCase();
  return /(?:^|[^a-z])(cover|front|표지)(?:[^a-z]|$)/u.test(label);
}

function candidateAttempt(pageRoot, page, runId) {
  const blocks = new Map((page.blocks ?? []).map((block) => [block.id, block]));
  const attempts = listDirectories(pageRoot)
    .filter((entry) => /^attempt-\d+$/u.test(path.basename(entry)))
    .sort(
      (left, right) =>
        Number(path.basename(right).slice(8)) -
        Number(path.basename(left).slice(8)),
    );
  let best = null;
  for (const attemptRoot of attempts) {
    const overlayPath = path.join(attemptRoot, "overlay-items.json");
    const resultPath = path.join(attemptRoot, "result.json");
    if (!fs.existsSync(overlayPath) || !fs.existsSync(resultPath)) continue;
    const overlay = readJson(overlayPath);
    const items = Array.isArray(overlay.items) ? overlay.items : [];
    let matchCount = 0;
    for (let index = 0; index < items.length; index += 1) {
      const block = blocks.get(`${page.id}-${runId}-block-${index + 1}`);
      if (
        block &&
        normalizeText(block.sourceText) ===
          normalizeText(items[index]?.sourceText ?? items[index]?.jp)
      ) {
        matchCount += 1;
      }
    }
    if (!best || matchCount > best.matchCount) {
      best = { attemptRoot, items, result: readJson(resultPath), matchCount };
    }
  }
  return best;
}

function collectRows(args) {
  const rowsByBlockId = new Map();
  const errors = [];
  let skippedCoverPages = 0;
  const worksRoot = path.join(args.library, "works");
  for (const workRoot of listDirectories(worksRoot)) {
    const workPath = path.join(workRoot, "work.json");
    const work = fs.existsSync(workPath) ? readJson(workPath) : {};
    const chaptersRoot = path.join(workRoot, "chapters");
    for (const chapterRoot of listDirectories(chaptersRoot)) {
      const chapterPath = path.join(chapterRoot, "chapter.json");
      if (!fs.existsSync(chapterPath)) continue;
      const chapter = readJson(chapterPath);
      const pages = Array.isArray(chapter.pages) ? chapter.pages : [];
      const runsRoot = path.join(chapterRoot, "runs");
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        const page = pages[pageIndex];
        if (!page || !Array.isArray(page.blocks) || page.blocks.length === 0) {
          continue;
        }
        if (isCoverLike(page, pageIndex, args.excludeLeadingPages)) {
          skippedCoverPages += 1;
          continue;
        }
        const blocks = new Map(page.blocks.map((block) => [block.id, block]));
        for (const runRoot of listDirectories(runsRoot)) {
          const runId = path.basename(runRoot);
          const pageRoot = path.join(runRoot, "pages", String(page.id));
          if (!fs.existsSync(pageRoot)) continue;
          const chosen = candidateAttempt(pageRoot, page, runId);
          if (!chosen || chosen.matchCount === 0) continue;
          const requestSummary = chosen.result.requestSummary ?? {};
          const hints = Array.isArray(requestSummary.ocrBboxHints)
            ? requestSummary.ocrBboxHints
            : [];
          const normalizedItems = chosen.items.map((item) =>
            normalizeRawItem(item, requestSummary, page),
          );
          let lockedItems;
          try {
            lockedItems = applyOcrCandidateGeometryLocks(
              normalizedItems,
              { width: page.width, height: page.height },
              hints,
            );
          } catch (error) {
            errors.push({
              pageId: page.id,
              runId,
              attempt: path.basename(chosen.attemptRoot),
              message: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          for (let index = 0; index < normalizedItems.length; index += 1) {
            const blockId = `${page.id}-${runId}-block-${index + 1}`;
            const block = blocks.get(blockId);
            if (!block) continue;
            const rawItem = normalizedItems[index];
            const lockedItem = lockedItems[index];
            if (
              normalizeText(block.sourceText) !==
              normalizeText(rawItem?.sourceText ?? rawItem?.jp)
            ) {
              continue;
            }
            const rawPixels = toPixels(rawItem.bbox, page);
            const lockedPixels = toPixels(lockedItem.bbox, page);
            const storedPixels = toPixels(block.bbox, page);
            const storedArea = bboxArea(storedPixels);
            const lockedArea = bboxArea(lockedPixels);
            const expansionRatio = lockedArea / Math.max(1, storedArea);
            const sourceFacePx = Number(block.sourceFontFacePx);
            rowsByBlockId.set(blockId, {
              workId: path.basename(workRoot),
              workTitle: work.title ?? work.name ?? "",
              chapterId: path.basename(chapterRoot),
              chapterTitle: chapter.title ?? chapter.name ?? "",
              pageId: page.id,
              pageNumber: pageIndex + 1,
              pageName: page.name,
              imagePath: page.imagePath,
              inpaintedImagePath: page.inpaintedImagePath,
              runId,
              attempt: path.basename(chosen.attemptRoot),
              resultPath: path.join(chosen.attemptRoot, "result.json"),
              blockId,
              itemId: rawItem.id,
              sourceText: block.sourceText,
              translatedText: block.translatedText,
              textRole: block.textRole,
              fontRole: block.fontRole,
              direction: rawItem.direction ?? block.sourceDirection,
              fontFamily: block.fontFamily,
              fontSizePx: block.fontSizePx,
              sourceFontFacePx: Number.isFinite(sourceFacePx)
                ? round(sourceFacePx)
                : null,
              rawModelBboxPx: roundedBbox(rawPixels),
              persistedBboxPx: roundedBbox(storedPixels),
              currentLockBboxPx: roundedBbox(lockedPixels),
              sourceFontLineCount:
                lockedItem.sourceFontLineGeometry?.lines?.length ?? 0,
              sourceFontLineCandidateIds:
                lockedItem.sourceFontLineGeometry?.lines?.map(
                  (line) => line.candidateId,
                ) ?? [],
              geometryExpansionRatio: round(expansionRatio),
              geometryExpanded:
                expansionRatio >= 1.5 &&
                (lockedPixels.w >= storedPixels.w * 1.2 ||
                  lockedPixels.h >= storedPixels.h * 1.2),
            });
          }
        }
      }
    }
  }
  const rows = [...rowsByBlockId.values()].sort(
    (left, right) =>
      right.geometryExpansionRatio - left.geometryExpansionRatio ||
      String(left.blockId).localeCompare(String(right.blockId)),
  );
  return { rows, errors, skippedCoverPages };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { rows, errors, skippedCoverPages } = collectRows(args);
  const geometryExpanded = rows.filter((row) => row.geometryExpanded);
  const lowFace = rows.filter(
    (row) => row.sourceFontFacePx !== null && row.sourceFontFacePx <= 14,
  );
  const lowFaceExpanded = lowFace.filter((row) => row.geometryExpanded);
  const lineGeometryBlocks = rows.filter((row) => row.sourceFontLineCount >= 1);
  const multiLineGeometryBlocks = rows.filter(
    (row) => row.sourceFontLineCount >= 2,
  );
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    libraryRoot: args.library,
    coverPolicy: {
      excludeLeadingPages: args.excludeLeadingPages,
      skippedPages: skippedCoverPages,
    },
    summary: {
      activeBlocksAudited: rows.length,
      geometryExpanded: geometryExpanded.length,
      sourceFaceAtMost14: lowFace.length,
      lowFaceGeometryExpanded: lowFaceExpanded.length,
      lineGeometryBlocks: lineGeometryBlocks.length,
      multiLineGeometryBlocks: multiLineGeometryBlocks.length,
      errors: errors.length,
    },
    topGeometryExpansions: geometryExpanded.slice(0, 100),
    lowFaceGeometryExpansions: lowFaceExpanded,
    rows,
    errors,
  };
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({ ...report.summary, output: args.output }, null, 2),
  );
}

main();
