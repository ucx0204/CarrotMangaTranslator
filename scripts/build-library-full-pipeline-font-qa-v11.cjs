#!/usr/bin/env node
/* eslint-disable @typescript-eslint/ban-ts-comment -- this CLI validates versioned QA artifacts at runtime */
/* eslint-disable max-lines -- the immutable build and independent validator share one CLI contract */
// @ts-nocheck -- schema-flexible artifact inputs are validated at runtime.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  cohortDigest,
  materializeCohort,
  readLibraryCandidates,
  sha256,
  sha256File,
  summarizeCohort,
} = require("./library-full-pipeline-qa/selection.cjs");
const {
  assertNotCurrentV10Holdout,
  boundaryCounts,
  boundaryFilesBindingSha256,
  excludeStrictIdentityOverlap,
  excludeStrictShaOverlap,
  scanMasterWorkUnion,
  scanStrictSourceBoundaries,
  selectStrictBaseline,
  serializeMasterWorkUnion,
  serializeSourceBoundary,
  validateStrictBaselineRecords,
} = require("./library-full-pipeline-qa/strict-baseline-selection.cjs");
const {
  currentV10HoldoutPath,
  v11BoundaryGroups,
} = require("./library-full-pipeline-qa/v11-boundary-inputs.cjs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(
  ROOT,
  "artifacts",
  "library-full-pipeline-font-qa-v11-r2",
);
const DEFAULT_MASTER = path.join(
  ROOT,
  "datasets",
  "font-matching-master-v3",
  "manifest.jsonl",
);
const DEFAULT_SEED = "font-qa-v11-master-v3-work-disjoint-20260811";
const TARGET = 40;
const MAX_PAGES_PER_WORK = 5;

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "preflight") {
    const prepared = await prepareV11(parsed.options);
    console.log(JSON.stringify(preflightReport(prepared), null, 2));
    return;
  }
  if (parsed.command === "build") {
    const result = await buildV11(parsed.options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (parsed.command === "validate") {
    const result = await validateV11(parsed.options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (parsed.command === "help") return printHelp();
  throw new Error(`Unknown command: ${parsed.command}`);
}

/** @param {Record<string, unknown>} options */
async function prepareV11(options = {}) {
  const libraryRoot = path.resolve(
    String(options.library || path.join(ROOT, "library")),
  );
  const masterManifestPath = path.resolve(
    String(options.master || DEFAULT_MASTER),
  );
  const seed = String(options.seed || DEFAULT_SEED);
  const workBoundary = await scanMasterWorkUnion(masterManifestPath);
  if (workBoundary.workIds.size !== 24) {
    throw new Error(
      `master-v3 work union must contain exactly 24 works; got ${workBoundary.workIds.size}`,
    );
  }
  if (workBoundary.recordsRead !== 28_094) {
    throw new Error(
      `master-v3 manifest row count must remain 28094; got ${workBoundary.recordsRead}`,
    );
  }
  const boundaryGroups = v11BoundaryGroups(ROOT);
  const sourceBoundary = await scanStrictSourceBoundaries(boundaryGroups);
  const libraryCandidates = await readLibraryCandidates(libraryRoot);
  const identitySafe = excludeStrictIdentityOverlap(
    libraryCandidates,
    workBoundary,
    sourceBoundary,
  );
  const shaSafe = await excludeStrictShaOverlap(
    identitySafe.eligible,
    sourceBoundary.sourcePageSha256s,
  );
  const matchedMasterWorks = new Set(
    libraryCandidates
      .filter((candidate) => workBoundary.workIds.has(candidate.workId))
      .map((candidate) => candidate.workId),
  );
  if (matchedMasterWorks.size !== 24) {
    throw new Error(
      `All 24 master-v3 works must exist in the library; matched ${matchedMasterWorks.size}`,
    );
  }
  const stats = {
    library: summarizeCandidates(libraryCandidates),
    afterMasterWorkExclusion: summarizeCandidates(identitySafe.afterWork),
    afterPageIdPathExclusion: summarizeCandidates(identitySafe.eligible),
    afterSourceShaExclusion: summarizeCandidates(shaSafe.candidates),
    excludedByMasterWork:
      libraryCandidates.length - identitySafe.afterWork.length,
    excludedByPageIdOrPath:
      identitySafe.afterWork.length - identitySafe.eligible.length,
    excludedBySourcePageSha256: shaSafe.excludedBySha,
  };
  if (stats.afterSourceShaExclusion.uniqueChapterCapacityAtMax5 < TARGET) {
    throw new Error(
      "Fewer than 40 unique-chapter pages remain under max-5/work",
    );
  }
  return {
    seed,
    libraryRoot,
    masterManifestPath,
    workBoundary,
    sourceBoundary,
    boundaryGroups,
    libraryCandidates,
    eligibleCandidates: shaSafe.candidates,
    fileHashCache: shaSafe.fileHashCache,
    stats,
  };
}

/** @param {Record<string, unknown>} options */
async function buildV11(options = {}) {
  const outputRoot = path.resolve(String(options.output || DEFAULT_OUTPUT));
  if (fs.existsSync(outputRoot)) {
    throw new Error(
      `Refusing to overwrite existing v11 artifact root: ${outputRoot}`,
    );
  }
  const prepared = await prepareV11(options);
  const selected = selectStrictBaseline(prepared.eligibleCandidates, {
    seed: prepared.seed,
    target: TARGET,
    maxPagesPerWork: MAX_PAGES_PER_WORK,
  });
  const records = await materializeCohort(
    selected,
    "baseline40",
    prepared.fileHashCache,
  );
  const proof = validateStrictBaselineRecords(records, {
    target: TARGET,
    maxPagesPerWork: MAX_PAGES_PER_WORK,
    workIds: prepared.workBoundary.workIds,
    sourceBoundary: prepared.sourceBoundary,
  });
  if (proof.errors.length > 0 || proof.chapters !== TARGET) {
    throw new Error(`v11 cohort proof failed: ${proof.errors.join("; ")}`);
  }
  await fsp.mkdir(outputRoot, { recursive: false });
  await fsp.mkdir(path.join(outputRoot, "boundaries"), { recursive: false });
  await fsp.mkdir(path.join(outputRoot, "cohorts"), { recursive: false });
  const generatedAt = new Date().toISOString();
  const workUnionPath = path.join(
    outputRoot,
    "boundaries",
    "master-v3-work-union.jsonl",
  );
  const sourceBoundaryPath = path.join(
    outputRoot,
    "boundaries",
    "source-page-boundary.json",
  );
  const cohortPath = path.join(outputRoot, "cohorts", "baseline40.jsonl");
  await writeJsonlExclusive(
    workUnionPath,
    serializeMasterWorkUnion(prepared.workBoundary),
  );
  await writeJsonExclusive(
    sourceBoundaryPath,
    serializeSourceBoundary(prepared.sourceBoundary),
  );
  await writeJsonlExclusive(cohortPath, records);
  const boundarySealPath = path.join(outputRoot, "boundary-seal.json");
  const boundarySeal = {
    schemaVersion: 1,
    toolVersion: "library-font-qa-v11-strict-boundary-v2",
    generatedAt,
    policy: {
      masterWorkUnion:
        "exclude every work in the master-v3 train/val/test union",
      sourcePages:
        "exclude page id, normalized source path, and source-page SHA from every sealed prior-QA or label authority input",
    },
    currentV10HoldoutIsolation: {
      pathLiteralOnly: currentV10HoldoutPath(ROOT),
      status: "unopened_reserved_not_consumed",
      includedInBoundaryInputs: false,
    },
    masterWorkBoundary: {
      file: prepared.workBoundary.file,
      workCount: prepared.workBoundary.workIds.size,
      splitRows: prepared.workBoundary.splitRows,
      unionBindingSha256: cohortDigest(
        serializeMasterWorkUnion(prepared.workBoundary),
      ),
      snapshot: await fileBinding(workUnionPath),
    },
    sourcePageBoundary: {
      ...boundaryCounts(prepared.sourceBoundary),
      recordsRead: prepared.sourceBoundary.recordsRead,
      fileCount: prepared.sourceBoundary.files.length,
      inputBindingSha256: boundaryFilesBindingSha256(
        prepared.sourceBoundary.files,
      ),
      files: prepared.sourceBoundary.files,
      snapshot: await fileBinding(sourceBoundaryPath),
    },
  };
  await writeJsonExclusive(boundarySealPath, boundarySeal);
  await writeShaSidecarExclusive(boundarySealPath);
  const cohortSummary = summarizeCohort(records);
  const cohortBinding = await fileBinding(cohortPath);
  const runnerBoundaries = buildRunnerBoundaryContract(
    prepared,
    boundarySeal.masterWorkBoundary.snapshot,
  );
  const selectionPath = path.join(outputRoot, "selection.json");
  const selection = {
    schemaVersion: 1,
    artifactVersion: path.basename(outputRoot),
    generatedAt,
    seed: prepared.seed,
    libraryRoot: prepared.libraryRoot,
    constraints: {
      pages: TARGET,
      preferredDistinctChapters: TARGET,
      maximumPagesPerWork: MAX_PAGES_PER_WORK,
      maximizeWorkDiversity: true,
      masterV3WorkUnionExcluded: true,
    },
    boundarySeal: await fileBinding(boundarySealPath),
    sourceBoundary: runnerBoundaries.sourceBoundary,
    workBoundary: runnerBoundaries.workBoundary,
    currentV10HoldoutIsolation: boundarySeal.currentV10HoldoutIsolation,
    supersedesInvalidArtifact: {
      path: path.join(ROOT, "artifacts", "library-full-pipeline-font-qa-v11"),
      status: "invalid_not_for_use",
      reason: "runner_contract_missing_cohort_manifestPath",
      immutablePredecessorModified: false,
    },
    candidatePool: prepared.stats,
    cohortSelection: {
      algorithmVersion: "work-first-unique-chapter-round-robin-v1",
      workDiversityUpperBound: Math.min(
        TARGET,
        prepared.stats.afterSourceShaExclusion.works,
      ),
      uniqueChapterCapacityAtMax5:
        prepared.stats.afterSourceShaExclusion.uniqueChapterCapacityAtMax5,
    },
    cohorts: {
      baseline40: runnerCohortDetails(
        cohortBinding,
        cohortDigest(records),
        cohortSummary,
      ),
    },
    overlapProof: {
      masterV3WorkUnionCount: 24,
      selectedMasterV3WorkOverlap: 0,
      selectedSourcePageIdOverlap: 0,
      selectedSourcePathOverlap: 0,
      selectedSourcePageSha256Overlap: 0,
      selectedPages: proof.pages,
      selectedWorks: proof.works,
      selectedChapters: proof.chapters,
      maximumPagesPerWork: proof.maximumPagesPerWork,
    },
  };
  await writeJsonExclusive(selectionPath, selection);
  await writeShaSidecarExclusive(selectionPath);
  return {
    outputRoot,
    preflight: preflightReport(prepared),
    cohort: selection.cohorts.baseline40,
    overlapProof: selection.overlapProof,
  };
}

/** @param {Record<string, unknown>} options */
// eslint-disable-next-line complexity, max-lines-per-function -- fail-closed validation checks every sealed boundary dimension.
async function validateV11(options = {}) {
  const outputRoot = path.resolve(String(options.output || DEFAULT_OUTPUT));
  const selectionPath = path.join(outputRoot, "selection.json");
  const boundarySealPath = path.join(outputRoot, "boundary-seal.json");
  await validateShaSidecar(selectionPath);
  await validateShaSidecar(boundarySealPath);
  const selection = JSON.parse(await fsp.readFile(selectionPath, "utf8"));
  const seal = JSON.parse(await fsp.readFile(boundarySealPath, "utf8"));
  const prepared = await prepareV11({
    ...options,
    seed: options.seed || selection.seed,
    library: options.library || selection.libraryRoot,
    master: options.master || seal.masterWorkBoundary?.file?.path,
  });
  const errors = [];
  compareBinding(
    selection.boundarySeal,
    await fileBinding(boundarySealPath),
    errors,
  );
  compareBinding(
    seal.masterWorkBoundary?.file,
    prepared.workBoundary.file,
    errors,
  );
  if (seal.masterWorkBoundary?.workCount !== 24)
    errors.push("sealed work count is not 24");
  if (
    seal.masterWorkBoundary?.unionBindingSha256 !==
    cohortDigest(serializeMasterWorkUnion(prepared.workBoundary))
  ) {
    errors.push("master work-union binding drift");
  }
  const workUnionPath = path.join(
    outputRoot,
    "boundaries",
    "master-v3-work-union.jsonl",
  );
  const sourceBoundaryPath = path.join(
    outputRoot,
    "boundaries",
    "source-page-boundary.json",
  );
  compareBinding(
    seal.masterWorkBoundary?.snapshot,
    await fileBinding(workUnionPath),
    errors,
  );
  compareBinding(
    seal.sourcePageBoundary?.snapshot,
    await fileBinding(sourceBoundaryPath),
    errors,
  );
  const expectedWorkSnapshot = `${serializeMasterWorkUnion(
    prepared.workBoundary,
  )
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;
  if ((await fsp.readFile(workUnionPath, "utf8")) !== expectedWorkSnapshot) {
    errors.push("master work-union snapshot drift");
  }
  const expectedSourceSnapshot = JSON.stringify(
    serializeSourceBoundary(prepared.sourceBoundary),
    null,
    2,
  ).concat("\n");
  if (
    (await fsp.readFile(sourceBoundaryPath, "utf8")) !== expectedSourceSnapshot
  ) {
    errors.push("source-page boundary snapshot drift");
  }
  const expectedFiles = prepared.sourceBoundary.files;
  if (
    JSON.stringify(seal.sourcePageBoundary?.files) !==
    JSON.stringify(expectedFiles)
  ) {
    errors.push("source boundary input inventory drift");
  }
  if (
    seal.sourcePageBoundary?.inputBindingSha256 !==
    boundaryFilesBindingSha256(expectedFiles)
  ) {
    errors.push("source boundary input binding drift");
  }
  const currentBoundaryCounts = boundaryCounts(prepared.sourceBoundary);
  for (const [key, value] of Object.entries(currentBoundaryCounts)) {
    if (seal.sourcePageBoundary?.[key] !== value) {
      errors.push(`source boundary ${key} count drift`);
    }
  }
  if (
    seal.sourcePageBoundary?.recordsRead !== prepared.sourceBoundary.recordsRead
  ) {
    errors.push("source boundary recordsRead drift");
  }
  for (const file of expectedFiles) assertNotCurrentV10Holdout(file.path);
  const expectedRunnerBoundaries = buildRunnerBoundaryContract(
    prepared,
    await fileBinding(workUnionPath),
  );
  if (
    JSON.stringify(selection.sourceBoundary) !==
    JSON.stringify(expectedRunnerBoundaries.sourceBoundary)
  ) {
    errors.push("runner sourceBoundary contract drift");
  }
  if (
    JSON.stringify(selection.workBoundary) !==
    JSON.stringify(expectedRunnerBoundaries.workBoundary)
  ) {
    errors.push("runner workBoundary contract drift");
  }
  const cohortPath = path.join(outputRoot, "cohorts", "baseline40.jsonl");
  const records = await readJsonl(cohortPath);
  const cohortBinding = await fileBinding(cohortPath);
  compareBinding(selection.cohorts?.baseline40, cohortBinding, errors);
  if (selection.cohorts?.baseline40?.manifestPath !== cohortPath) {
    errors.push("runner cohort manifestPath drift");
  }
  if (selection.cohorts?.baseline40?.manifestSha256 !== cohortDigest(records)) {
    errors.push("cohort canonical digest drift");
  }
  const proof = validateStrictBaselineRecords(records, {
    target: TARGET,
    maxPagesPerWork: MAX_PAGES_PER_WORK,
    workIds: prepared.workBoundary.workIds,
    sourceBoundary: prepared.sourceBoundary,
  });
  errors.push(...proof.errors);
  if (proof.chapters !== TARGET)
    errors.push(`expected 40 chapters, got ${proof.chapters}`);
  if (
    proof.works !==
    Math.min(TARGET, prepared.stats.afterSourceShaExclusion.works)
  ) {
    errors.push("selected work diversity is below the exact upper bound");
  }
  for (const [key, value] of Object.entries({
    selectedMasterV3WorkOverlap: 0,
    selectedSourcePageIdOverlap: 0,
    selectedSourcePathOverlap: 0,
    selectedSourcePageSha256Overlap: 0,
    selectedPages: proof.pages,
    selectedWorks: proof.works,
    selectedChapters: proof.chapters,
    maximumPagesPerWork: proof.maximumPagesPerWork,
  })) {
    if (selection.overlapProof?.[key] !== value) {
      errors.push(`selection overlap proof drift: ${key}`);
    }
  }
  const candidatesByPage = new Map(
    prepared.libraryCandidates.map((candidate) => [
      candidate.pageId,
      candidate,
    ]),
  );
  for (const record of records) {
    const candidate = candidatesByPage.get(record.page?.id);
    if (!candidate) {
      errors.push(`selected page no longer exists: ${record.page?.id}`);
      continue;
    }
    if (
      candidate.workId !== record.work?.id ||
      candidate.chapterId !== record.chapter?.id ||
      candidate.imageRelativePath !== record.page?.imageRelativePath
    ) {
      errors.push(`selected page metadata drift: ${record.page?.id}`);
    }
    const currentSha = await sha256File(candidate.imagePath);
    if (currentSha !== record.page?.imageSha256) {
      errors.push(`selected source bytes drift: ${record.page?.id}`);
    }
  }
  if (
    JSON.stringify(selection.candidatePool) !== JSON.stringify(prepared.stats)
  ) {
    errors.push("candidate-pool counts drift");
  }
  if (
    selection.currentV10HoldoutIsolation?.status !==
    "unopened_reserved_not_consumed"
  ) {
    errors.push("v10 holdout isolation contract missing");
  }
  if (
    selection.supersedesInvalidArtifact?.status !== "invalid_not_for_use" ||
    selection.supersedesInvalidArtifact?.immutablePredecessorModified !== false
  ) {
    errors.push("invalid v11 predecessor disposition is not sealed");
  }
  if (errors.length > 0)
    throw new Error(`v11 validation failed:\n- ${errors.join("\n- ")}`);
  return {
    valid: true,
    outputRoot,
    masterV3WorkUnion: prepared.workBoundary.workIds.size,
    sourceBoundary: boundaryCounts(prepared.sourceBoundary),
    candidatePool: prepared.stats,
    cohort: proof,
    currentV10Holdout: "unopened_reserved_not_consumed",
    runnerContract: {
      manifestPath: selection.cohorts.baseline40.manifestPath,
      sourceBoundary: Boolean(selection.sourceBoundary),
      workBoundary: Boolean(selection.workBoundary),
    },
  };
}

function preflightReport(prepared) {
  return {
    masterV3: {
      manifestPath: prepared.masterManifestPath,
      manifestSha256: prepared.workBoundary.file.sha256,
      rows: prepared.workBoundary.recordsRead,
      works: prepared.workBoundary.workIds.size,
      splitRows: prepared.workBoundary.splitRows,
    },
    sourceBoundary: {
      files: prepared.sourceBoundary.files.length,
      records: prepared.sourceBoundary.recordsRead,
      ...boundaryCounts(prepared.sourceBoundary),
    },
    candidatePool: prepared.stats,
    feasibility: {
      targetPages: TARGET,
      achievableDistinctWorks: Math.min(
        TARGET,
        prepared.stats.afterSourceShaExclusion.works,
      ),
      achievableDistinctChapters: Math.min(
        TARGET,
        prepared.stats.afterSourceShaExclusion.uniqueChapterCapacityAtMax5,
      ),
      maximumPagesPerWork: MAX_PAGES_PER_WORK,
    },
    currentV10Holdout: {
      status: "unopened_reserved_not_consumed",
      includedInBoundaryInputs: false,
    },
  };
}

function summarizeCandidates(candidates) {
  const works = new Map();
  const chapters = new Set();
  for (const candidate of candidates) {
    chapters.add(`${candidate.workId}\0${candidate.chapterId}`);
    let work = works.get(candidate.workId);
    if (!work) {
      work = { pages: 0, chapters: new Set() };
      works.set(candidate.workId, work);
    }
    work.pages += 1;
    work.chapters.add(candidate.chapterId);
  }
  return {
    pages: candidates.length,
    works: works.size,
    chapters: chapters.size,
    uniqueChapterCapacityAtMax5: [...works.values()].reduce(
      (total, work) => total + Math.min(MAX_PAGES_PER_WORK, work.chapters.size),
      0,
    ),
  };
}

function runnerCohortDetails(binding, manifestSha256, summary) {
  return {
    ...binding,
    manifestPath: binding.path,
    manifestSha256,
    ...summary,
  };
}

function buildRunnerBoundaryContract(prepared, workUnionBinding) {
  const sourceFiles = prepared.sourceBoundary.files;
  const workFile = {
    ...workUnionBinding,
    recordsRead: prepared.workBoundary.workIds.size,
  };
  return {
    sourceBoundary: {
      policy:
        "exclude sealed prior-QA and labeling source page ids, normalized paths, and source-page SHA-256 values",
      fileCount: sourceFiles.length,
      recordsRead: prepared.sourceBoundary.recordsRead,
      excludedPageIds: prepared.sourceBoundary.pageIds.size,
      excludedRelativePaths: prepared.sourceBoundary.relativePaths.size,
      excludedSourcePageSha256s: prepared.sourceBoundary.sourcePageSha256s.size,
      bindingSha256: runnerBoundaryFilesBindingSha256(sourceFiles),
      files: sourceFiles,
    },
    workBoundary: {
      policy: "exclude the exact master-v3 train/val/test work union",
      acceptedRecordShapes: ["work.id"],
      fileCount: 1,
      recordsRead: prepared.workBoundary.workIds.size,
      excludedWorkCount: prepared.workBoundary.workIds.size,
      matchedLibraryWorkCount: prepared.workBoundary.workIds.size,
      excludedLibraryPages: prepared.stats.excludedByMasterWork,
      bindingSha256: runnerBoundaryFilesBindingSha256([workFile]),
      files: [workFile],
    },
  };
}

function runnerBoundaryFilesBindingSha256(files) {
  return sha256(files.map((file) => `${file.path}:${file.sha256}`).join("\n"));
}

async function fileBinding(filePath) {
  const resolved = path.resolve(filePath);
  const stat = await fsp.stat(resolved);
  return {
    path: resolved,
    sizeBytes: stat.size,
    sha256: await sha256File(resolved),
  };
}

function compareBinding(sealed, current, errors) {
  for (const key of ["path", "sizeBytes", "sha256"]) {
    if (sealed?.[key] !== current?.[key])
      errors.push(`binding ${key} drift: ${current?.path}`);
  }
}

async function writeJsonExclusive(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function writeJsonlExclusive(filePath, records) {
  await fsp.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeShaSidecarExclusive(filePath) {
  const digest = await sha256File(filePath);
  await fsp.writeFile(
    `${filePath}.sha256`,
    `${digest}  ${path.basename(filePath)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function validateShaSidecar(filePath) {
  const expected = `${await sha256File(filePath)}  ${path.basename(filePath)}\n`;
  const actual = await fsp.readFile(`${filePath}.sha256`, "utf8");
  if (actual !== expected) throw new Error(`SHA sidecar mismatch: ${filePath}`);
}

async function readJsonl(filePath) {
  const text = await fsp.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function parseArguments(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "help";
  const options = {};
  for (
    let index = command === "help" ? 0 : 1;
    index < argv.length;
    index += 1
  ) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) options[key] = true;
    else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function printHelp() {
  console.log(
    "Strict v11 fresh-baseline cohort builder (CPU/filesystem only)\n\n" +
      "  preflight  Recompute exact work/page/SHA availability without writing\n" +
      "  build      Create a new immutable v11 baseline40 and boundary seal\n" +
      "  validate   Recompute every boundary and validate the frozen artifact\n\n" +
      "Options: --library <path> --master <manifest.jsonl> --output <new-dir> --seed <seed>",
  );
}

module.exports = {
  buildRunnerBoundaryContract,
  buildV11,
  parseArguments,
  prepareV11,
  preflightReport,
  runnerCohortDetails,
  summarizeCandidates,
  validateV11,
};
