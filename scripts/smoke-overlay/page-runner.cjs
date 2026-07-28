const { nativeImage } = require("electron");
const { copyFile, mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { countBlockTypes, readReusableOcrHints } = require("./options.cjs");
const { withTimeout } = require("./utils.cjs");

/**
 * @typedef {import("../../src/shared/libraryTypes").MangaPage} MangaPage
 * @typedef {import("../../src/shared/textTypes").TranslationBlock} TranslationBlock
 * @typedef {{ filePath: string; groupKey: string; hash: number }} SmokeSample
 * @typedef {{ pattern: number; other: number }} BlockTypeCounts
 * @typedef {{ index: number; sample: SmokeSample; geometryPath: string; overlayPath: string; blockCount: number; typeCounts: BlockTypeCounts; elapsedMs: number }} RenderedSmokeItem
 * @typedef {{ sample: SmokeSample; message: string; status?: unknown; statusText?: unknown; rawTextPreview?: unknown; requestSummary?: unknown }} SkippedSmokeItem
 * @typedef {{ requestTranslation(server: unknown, options: Record<string, unknown>): Promise<any>; saveArtifacts(options: Record<string, unknown>, result: any): Promise<void> }} SimplePageModule
 * @typedef {{ parseJsonLenient(text: string): unknown; normalizeItems(parsed: unknown): any[] }} OverlayTools
 * @typedef {{ baseOptions: Record<string, any>; pageTimeoutMs: number; reuseOcrDir: string; simplePage: SimplePageModule; overlayTools: OverlayTools; applyOcrCandidateGeometryLocks: Function; filterRejectedOrUncertainSoundItems: Function; getPipelineBboxNormalizationOptions: Function; getOcrBboxHints: Function; normalizeOverlayItemBboxes: Function; overlayItemToBlock: Function; renderGeometryPng: Function; renderOverlayPng: Function }} PageRunnerDependencies
 */

/** @param {PageRunnerDependencies} dependencies */
function createPageRunner(dependencies) {
  return {
    /** @param {{ samples: SmokeSample[]; pagesDir: string; sampleCount: number; server: unknown }} input */
    runCandidates: (input) => runCandidates(dependencies, input),
  };
}

/** @param {PageRunnerDependencies} dependencies @param {{ samples: SmokeSample[]; pagesDir: string; sampleCount: number; server: unknown }} input */
async function runCandidates(dependencies, input) {
  /** @type {RenderedSmokeItem[]} */
  const rendered = [];
  /** @type {SkippedSmokeItem[]} */
  const skipped = [];
  for (const [candidateIndex, sample] of input.samples.entries()) {
    if (rendered.length >= input.sampleCount) break;
    const pageOutDir = path.join(
      input.pagesDir,
      String(candidateIndex + 1).padStart(2, "0"),
    );
    await mkdir(pageOutDir, { recursive: true });
    const outcome = await processCandidate(dependencies, {
      candidateIndex,
      index: candidateIndex,
      pageOutDir,
      sample,
      sampleCount: input.sampleCount,
      samplesLength: input.samples.length,
      server: input.server,
    });
    if (outcome.rendered) rendered.push(outcome.rendered);
    if (outcome.skipped) skipped.push(outcome.skipped);
  }
  return { rendered, skipped };
}

/** @param {PageRunnerDependencies} dependencies @param {{ candidateIndex: number; index: number; pageOutDir: string; sample: SmokeSample; sampleCount: number; samplesLength: number; server: unknown }} input */
async function processCandidate(dependencies, input) {
  try {
    return {
      rendered: await analyzeAndRenderCandidate(dependencies, input),
    };
  } catch (error) {
    const skipped = toSkippedItem(input.sample, error);
    await writeFile(
      path.join(input.pageOutDir, "skip.json"),
      `${JSON.stringify(skipped, null, 2)}\n`,
      "utf8",
    );
    console.warn(`[smoke] skip ${input.sample.filePath}: ${skipped.message}`);
    return { skipped };
  }
}

/** @param {PageRunnerDependencies} dependencies @param {{ candidateIndex: number; index: number; pageOutDir: string; sample: SmokeSample; sampleCount: number; samplesLength: number; server: unknown }} input */
async function analyzeAndRenderCandidate(dependencies, input) {
  const page = createPageRecord(input.sample.filePath, input.index);
  const abortController = new AbortController();
  const pageOptions = await buildPageOptions(
    dependencies,
    input,
    page,
    abortController,
  );
  console.log(
    `[smoke] ${input.index + 1}/${input.sampleCount} candidate=${input.candidateIndex + 1}/${input.samplesLength} ${input.sample.filePath}`,
  );
  const startedAt = Date.now();
  const result = await withTimeout(
    dependencies.simplePage.requestTranslation(input.server, pageOptions),
    dependencies.pageTimeoutMs,
    `page timed out after ${dependencies.pageTimeoutMs}ms`,
    abortController,
  );
  await dependencies.simplePage.saveArtifacts(pageOptions, result);
  await persistOcrHints(input.pageOutDir, result, pageOptions);
  const analyzedPage = buildAnalyzedPage(dependencies, page, result);
  const paths = await persistPageArtifacts(dependencies, input, analyzedPage);
  return {
    index: input.index + 1,
    sample: input.sample,
    ...paths,
    blockCount: analyzedPage.blocks.length,
    typeCounts: countBlockTypes(analyzedPage.blocks),
    elapsedMs: Date.now() - startedAt,
  };
}

/** @param {PageRunnerDependencies} dependencies @param {{ index: number; pageOutDir: string; sample: SmokeSample }} input @param {MangaPage} page @param {AbortController} abortController */
async function buildPageOptions(dependencies, input, page, abortController) {
  const reusableHints = dependencies.reuseOcrDir
    ? await readReusableOcrHints(dependencies.reuseOcrDir, input.index + 1)
    : undefined;
  return {
    ...dependencies.baseOptions,
    imagePath: page.imagePath,
    imageWidth: page.width,
    imageHeight: page.height,
    outputDir: path.join(input.pageOutDir, "analysis"),
    label: `smoke-${input.index + 1}`,
    ...(reusableHints ? { ocrBboxHints: reusableHints } : {}),
    abortSignal: abortController.signal,
  };
}

/** @param {string} pageOutDir @param {any} result @param {Record<string, any>} pageOptions */
async function persistOcrHints(pageOutDir, result, pageOptions) {
  const hints = Array.isArray(result.requestBody?.ocrBboxHints)
    ? result.requestBody.ocrBboxHints
    : Array.isArray(pageOptions.ocrBboxHints)
      ? pageOptions.ocrBboxHints
      : [];
  if (hints.length === 0) return;
  await writeFile(
    path.join(pageOutDir, "ocr-bbox-hints.json"),
    `${JSON.stringify(hints, null, 2)}\n`,
    "utf8",
  );
}

/** @param {PageRunnerDependencies} dependencies @param {MangaPage} page @param {any} result */
function buildAnalyzedPage(dependencies, page, result) {
  const parsed = dependencies.overlayTools.parseJsonLenient(result.outputText);
  const items = dependencies.overlayTools.normalizeItems(parsed);
  if (items.length === 0) throw new Error("No overlay items parsed.");
  let normalized = dependencies.applyOcrCandidateGeometryLocks(
    dependencies.normalizeOverlayItemBboxes(
      items,
      page,
      dependencies.getPipelineBboxNormalizationOptions(result.requestBody),
    ),
    page,
    dependencies.getOcrBboxHints(result.requestBody),
  );
  normalized =
    dependencies.filterRejectedOrUncertainSoundItems(normalized).items;
  const normalizedItems = /** @type {any[]} */ (normalized);
  const blocks = normalizedItems.map((item, index) =>
    dependencies.overlayItemToBlock(item, page, index),
  );
  return /** @type {MangaPage & { normalizedItems: unknown[] }} */ ({
    ...page,
    blocks,
    normalizedItems,
    analysisStatus: "completed",
    updatedAt: new Date().toISOString(),
  });
}

/** @param {PageRunnerDependencies} dependencies @param {{ pageOutDir: string; sample: SmokeSample }} input @param {MangaPage & { normalizedItems: unknown[] }} page */
async function persistPageArtifacts(dependencies, input, page) {
  const geometryPath = path.join(input.pageOutDir, "geometry.png");
  const overlayPath = path.join(input.pageOutDir, "overlay.png");
  await copyFile(
    input.sample.filePath,
    path.join(
      input.pageOutDir,
      `original${path.extname(input.sample.filePath).toLowerCase()}`,
    ),
  );
  await writeFile(
    path.join(input.pageOutDir, "page.json"),
    `${JSON.stringify({ sample: input.sample, items: page.normalizedItems, page }, null, 2)}\n`,
    "utf8",
  );
  await dependencies.renderGeometryPng(page, page.blocks, geometryPath);
  await dependencies.renderOverlayPng(page, overlayPath);
  return { geometryPath, overlayPath };
}

/** @param {string} imagePath @param {number} index @returns {MangaPage} */
function createPageRecord(imagePath, index) {
  const size = nativeImage.createFromPath(imagePath).getSize();
  if (!size.width || !size.height) {
    throw new Error(`Failed to read image dimensions: ${imagePath}`);
  }
  const now = new Date().toISOString();
  return {
    id: `smoke-page-${index + 1}`,
    name: path.basename(imagePath),
    imagePath,
    dataUrl: "",
    width: size.width,
    height: size.height,
    blocks: [],
    analysisStatus: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

/** @param {SmokeSample} sample @param {unknown} error */
function toSkippedItem(sample, error) {
  const detail =
    error && typeof error === "object"
      ? /** @type {Record<string, unknown>} */ (error)
      : {};
  return {
    sample,
    message: error instanceof Error ? error.message : String(error),
    status: detail.status,
    statusText: detail.statusText,
    rawTextPreview: detail.rawTextPreview,
    requestSummary: detail.requestSummary,
  };
}

module.exports = { createPageRunner };
