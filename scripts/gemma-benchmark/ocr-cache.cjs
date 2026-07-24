/**
 * @typedef {{ id: string; name: string; imagePath: string; width: number; height: number }} BenchmarkSample
 * @typedef {{ [key: string]: unknown }} BenchmarkOptions
 * @typedef {{ collectOcrBboxHints(options: BenchmarkOptions): Promise<{ hints: unknown[] }> }} SimplePageModule
 */
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { REUSE_OCR_DIR } = require("./config.cjs");

/**
 * @param {SimplePageModule} simplePage
 * @param {BenchmarkOptions} baseOptions
 * @param {BenchmarkSample[]} samples
 * @param {string} pagesDir
 * @returns {Promise<Map<string, unknown[]>>}
 */
async function prepareCachedOcrHints(
  simplePage,
  baseOptions,
  samples,
  pagesDir,
) {
  /** @type {Map<string, unknown[]>} */
  const hintsByPath = new Map();
  for (const [index, sample] of samples.entries()) {
    const outputDir = path.join(
      pagesDir,
      String(index + 1).padStart(2, "0"),
      "ocr",
    );
    const reusedHints = await readReusableOcrHints(index);
    if (reusedHints) {
      hintsByPath.set(sample.imagePath, reusedHints);
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        path.join(outputDir, "ocr-hints.json"),
        `${JSON.stringify({ hints: reusedHints }, null, 2)}\n`,
        "utf8",
      );
      console.log(
        `[perf] reused OCR ${index + 1}/${samples.length}: hints=${reusedHints.length}`,
      );
      continue;
    }
    const options = {
      ...baseOptions,
      imagePath: sample.imagePath,
      imageWidth: sample.width,
      imageHeight: sample.height,
      outputDir,
      label: `perf-ocr-${index + 1}`,
      ocrProgressDefaultToPage: false,
    };
    const result = await simplePage.collectOcrBboxHints(options);
    hintsByPath.set(sample.imagePath, result.hints);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, "ocr-hints.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `[perf] cached OCR ${index + 1}/${samples.length}: hints=${result.hints.length}`,
    );
  }
  return hintsByPath;
}

/**
 * @param {number} sampleIndex
 * @returns {Promise<unknown[] | null>}
 */
async function readReusableOcrHints(sampleIndex) {
  if (!REUSE_OCR_DIR) {
    return null;
  }
  const pageDir = path.join(
    REUSE_OCR_DIR,
    "pages",
    String(sampleIndex + 1).padStart(2, "0"),
    "ocr",
  );
  const candidates = [
    path.join(pageDir, "ocr-bbox-hints.json"),
    path.join(pageDir, "ocr-hints.json"),
  ];
  for (const filePath of candidates) {
    try {
      const payload = JSON.parse(await readFile(filePath, "utf8"));
      const hints = normalizeReusableOcrHints(payload);
      if (hints.length > 0) {
        return hints;
      }
    } catch (_error) {
      // error-policy-allow: malformed or missing cache candidates are probed in order.
    }
  }
  return null;
}

/**
 * @param {unknown} payload
 * @returns {unknown[]}
 */
function normalizeReusableOcrHints(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record =
    payload && typeof payload === "object"
      ? /** @type {{ items?: unknown; hints?: unknown }} */ (payload)
      : {};
  if (Array.isArray(record.items)) {
    return record.items;
  }
  if (Array.isArray(record.hints)) {
    return record.hints;
  }
  return [];
}

module.exports = { prepareCachedOcrHints };
