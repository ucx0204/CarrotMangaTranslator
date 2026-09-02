/* eslint-disable -- isolated laboratory experiment evaluator */
// @ts-nocheck -- one-off laboratory experiment evaluator.
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const baselineRoot = path.resolve(readArg("--baseline") || "");
const candidateRoot = path.resolve(readArg("--candidate") || "");
const outputPath = path.resolve(
  readArg("--output") || "actual-chapter-parity.json",
);

if (!fs.existsSync(baselineRoot) || !fs.existsSync(candidateRoot)) {
  throw new Error(
    "Both --baseline and --candidate must point to existing experiment directories.",
  );
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const stable = (value) => JSON.stringify(value ?? null);
const sourceKey = (region) => [...region.sourceDetectionIds].sort().join("+");

const readPage = (root, pageId) => {
  const pageRoot = path.join(root, "pages", pageId);
  const geometry = readJson(path.join(pageRoot, "ocr", "hayai-regions.json"));
  const report = readJson(path.join(pageRoot, "page.json"));
  const candidates = new Map(
    report.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  return new Map(
    geometry.dialogueRegions.map((region) => [
      sourceKey(region),
      {
        ...region,
        candidate: candidates.get(region.regionId) || null,
      },
    ]),
  );
};

const pageIds = fs
  .readdirSync(path.join(baselineRoot, "pages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^P\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const pages = [];
const totals = {
  baselineDialogueCount: 0,
  candidateDialogueCount: 0,
  matchedCount: 0,
  baselineOnlyCount: 0,
  candidateOnlyCount: 0,
  exactBboxCount: 0,
  changedBboxCount: 0,
  exactOcrCount: 0,
  changedOcrCount: 0,
  exactEstimateCount: 0,
  changedEstimateCount: 0,
  recognitionOnlyChangeCount: 0,
};

for (const pageId of pageIds) {
  const baseline = readPage(baselineRoot, pageId);
  const candidate = readPage(candidateRoot, pageId);
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  const comparisons = [];

  totals.baselineDialogueCount += baseline.size;
  totals.candidateDialogueCount += candidate.size;

  for (const key of keys) {
    const before = baseline.get(key) || null;
    const after = candidate.get(key) || null;
    if (!before || !after) {
      if (before) totals.baselineOnlyCount += 1;
      if (after) totals.candidateOnlyCount += 1;
      comparisons.push({
        sourceDetectionIds: key.split("+"),
        before,
        after,
        status: before ? "baseline-only" : "candidate-only",
      });
      continue;
    }

    totals.matchedCount += 1;
    const bboxExact = stable(before.bbox) === stable(after.bbox);
    const recognitionExact =
      stable(before.recognitionBboxes) === stable(after.recognitionBboxes);
    const ocrExact =
      before.candidate?.sourceText === after.candidate?.sourceText;
    const estimateExact =
      stable(before.candidate?.estimate) === stable(after.candidate?.estimate);
    totals[bboxExact ? "exactBboxCount" : "changedBboxCount"] += 1;
    totals[ocrExact ? "exactOcrCount" : "changedOcrCount"] += 1;
    totals[estimateExact ? "exactEstimateCount" : "changedEstimateCount"] += 1;
    if (bboxExact && !recognitionExact) totals.recognitionOnlyChangeCount += 1;

    if (!bboxExact || !recognitionExact || !ocrExact || !estimateExact) {
      comparisons.push({
        sourceDetectionIds: key.split("+"),
        status: "changed",
        bboxExact,
        recognitionExact,
        ocrExact,
        estimateExact,
        before: {
          regionId: before.regionId,
          bbox: before.bbox,
          recognitionBboxes: before.recognitionBboxes || null,
          sourceText: before.candidate?.sourceText || "",
          estimate: before.candidate?.estimate || null,
        },
        after: {
          regionId: after.regionId,
          bbox: after.bbox,
          recognitionBboxes: after.recognitionBboxes || null,
          sourceText: after.candidate?.sourceText || "",
          estimate: after.candidate?.estimate || null,
        },
      });
    }
  }

  if (comparisons.length > 0) pages.push({ pageId, comparisons });
}

const result = {
  schemaVersion: 1,
  baselineRoot,
  candidateRoot,
  pageCount: pageIds.length,
  totals,
  pages,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
