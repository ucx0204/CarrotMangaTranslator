/* eslint-disable @typescript-eslint/ban-ts-comment -- this read-only CLI validates versioned artifacts at runtime */
// @ts-nocheck -- versioned read-only research artifacts are validated at runtime.
"use strict";

/**
 * Build isolated production-render A/B inputs for the v3 geometry failures.
 *
 * The baseline is the saved translated page. The candidate changes only the
 * source-face evidence of explicitly selected blocks, plus the recovered OCR
 * envelope when the saved box was collapsed. This keeps visual attribution
 * narrow: every rendered difference comes from the proposed v3 estimator.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const auditPath = path.resolve(
  process.env.MGT_SOURCE_SIZE_V3_AUDIT ||
    path.join(root, ".tmp/source-font-size-v3/geometry-audit-v5.json"),
);
const smokePath = path.resolve(
  process.env.MGT_SOURCE_SIZE_V3_SMOKE ||
    path.join(
      root,
      ".tmp/source-font-size-v3/geometry-production-smoke-all-lines-v5.json",
    ),
);
const outputRoot = path.resolve(
  process.env.MGT_SOURCE_SIZE_V3_RENDER_CASES ||
    path.join(root, ".tmp/source-font-size-v3/render-cases"),
);
const configId = "ocr-line-geometry-v3";

const targetSuffixes = [
  ["504d2b18-6429-435a-894b-668f93512040", "block-2"],
  ["c1a3f372-c545-4ea8-9cd1-4d2f21fa1bff", "block-1"],
  ["fa7237b5-c211-499b-a72c-23dd88033365", "block-4"],
  ["515ef1cc-d4a0-4287-9b02-d4a44b88d1ea", "block-5"],
  ["515ef1cc-d4a0-4287-9b02-d4a44b88d1ea", "block-6"],
];

run();

function run() {
  const audit = readJson(auditPath);
  const smoke = readJson(smokePath);
  const auditRows = requireRows(audit, auditPath);
  const smokeRows = requireRows(smoke, smokePath);
  const smokeByBlock = new Map(
    smokeRows.map((row) => [String(row.blockId || ""), row]),
  );

  const selected = targetSuffixes.map(([pagePrefix, blockSuffix]) => {
    const row = auditRows.find(
      (candidate) =>
        String(candidate.pageId || "").startsWith(pagePrefix) &&
        String(candidate.blockId || "").endsWith(blockSuffix),
    );
    if (!row) {
      throw new Error(`Missing audited target ${pagePrefix}/${blockSuffix}.`);
    }
    const estimate = smokeByBlock.get(String(row.blockId));
    if (!estimate?.lineGeometryEstimate) {
      throw new Error(`Missing v3 estimate for ${row.blockId}.`);
    }
    return { audit: row, estimate };
  });

  fs.mkdirSync(outputRoot, { recursive: true });
  const grouped = groupBy(selected, ({ audit: row }) => String(row.pageId));
  const pages = [];
  const estimates = [];
  let caseNumber = 0;
  for (const pageTargets of grouped.values()) {
    caseNumber += 1;
    const representative = pageTargets[0].audit;
    const chapterPath = chapterJsonFromResultPath(
      String(representative.resultPath || ""),
    );
    const chapter = readJson(chapterPath);
    const savedPage = requirePage(chapter, String(representative.pageId));
    const baseline = structuredClone(savedPage);
    const candidate = structuredClone(savedPage);
    const candidateBlocks = Array.isArray(candidate.blocks)
      ? candidate.blocks
      : [];

    for (const target of pageTargets) {
      const blockId = String(target.audit.blockId);
      const block = candidateBlocks.find(
        (candidateBlock) => String(candidateBlock?.id || "") === blockId,
      );
      if (!block) throw new Error(`Saved page is missing ${blockId}.`);
      const lineEstimate = target.estimate.lineGeometryEstimate;
      const oldFacePx = Number(block.sourceFontFacePx);
      block.sourceFontFacePx = Number(lineEstimate.facePx);
      block.sourceFontSizeConfidence = Number(lineEstimate.confidence);
      block.sourceFontSizeMethod = "raster-core-v1";
      if (target.audit.geometryExpanded) {
        block.bbox = normalizePixels(
          target.audit.currentLockBboxPx,
          Number(savedPage.width),
          Number(savedPage.height),
        );
        block.bboxSpace = "normalized_1000";
      }
      estimates.push({
        pageNumber: caseNumber,
        blockId,
        configId,
        applied: true,
        geometryExpanded: Boolean(target.audit.geometryExpanded),
        sourceText: target.audit.sourceText,
        oldFacePx,
        newFacePx: Number(lineEstimate.facePx),
      });
    }

    const pageDir = path.join(outputRoot, "pages", pad2(caseNumber));
    fs.mkdirSync(pageDir, { recursive: true });
    const baselinePath = path.join(pageDir, "baseline.json");
    const candidatePath = path.join(pageDir, `candidate-${configId}.json`);
    writeJson(baselinePath, baseline);
    writeJson(candidatePath, candidate);
    pages.push({
      pageNumber: caseNumber,
      sourcePageNumber: representative.pageNumber,
      pageId: representative.pageId,
      pageName: representative.pageName,
      workTitle: representative.workTitle,
      chapterTitle: representative.chapterTitle,
      originalImagePath: representative.imagePath,
      inpaintedImagePath: representative.inpaintedImagePath,
      baselinePage: path.relative(outputRoot, baselinePath),
      candidatePages: {
        [configId]: path.relative(outputRoot, candidatePath),
      },
    });
  }

  const manifestPath = path.join(outputRoot, "render-manifest.json");
  const estimatesPath = path.join(outputRoot, "block-estimates.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    cohort: "v3-targeted-inpainted-cases",
    configs: [
      {
        id: configId,
        description:
          "Recovered OCR envelope plus robust per-line source-face median",
      },
    ],
    pages,
  });
  writeJson(estimatesPath, estimates);
  console.log(
    JSON.stringify({
      pages: pages.length,
      blocks: estimates.length,
      manifest: manifestPath,
      estimates: estimatesPath,
    }),
  );
}

function chapterJsonFromResultPath(resultPath) {
  const marker = `${path.sep}runs${path.sep}`;
  const markerIndex = resultPath.toLowerCase().indexOf(marker.toLowerCase());
  if (markerIndex < 0) {
    throw new Error(`Unexpected result path: ${resultPath}`);
  }
  return path.join(resultPath.slice(0, markerIndex), "chapter.json");
}

function normalizePixels(bbox, pageWidth, pageHeight) {
  if (!bbox || pageWidth <= 0 || pageHeight <= 0) {
    throw new Error("Cannot normalize the recovered OCR envelope.");
  }
  return {
    x: (Number(bbox.x) / pageWidth) * 1_000,
    y: (Number(bbox.y) / pageHeight) * 1_000,
    w: (Number(bbox.w) / pageWidth) * 1_000,
    h: (Number(bbox.h) / pageHeight) * 1_000,
  };
}

function requireRows(value, sourcePath) {
  if (!Array.isArray(value?.rows)) {
    throw new Error(`Missing rows in ${sourcePath}.`);
  }
  return value.rows;
}

function requirePage(chapter, pageId) {
  const page = Array.isArray(chapter?.pages)
    ? chapter.pages.find((candidate) => String(candidate?.id || "") === pageId)
    : null;
  if (!page) throw new Error(`Missing page ${pageId}.`);
  return page;
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) || [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
