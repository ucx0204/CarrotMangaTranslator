/* eslint-disable @typescript-eslint/ban-ts-comment -- this CLI validates versioned manifests at runtime */
/* eslint-disable max-lines -- the CLI keeps selection, execution, and cache validation options auditable together */
// @ts-nocheck -- CLI arguments and versioned QA manifests are validated at runtime.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureElectronExecutable } = require("./electron-executable.cjs");
const {
  cohortDigest,
  excludeTrainingOverlap,
  excludeWorkBoundaryOverlap,
  materializeCohort,
  readLibraryCandidates,
  scanTrainingBoundaries,
  scanWorkBoundaries,
  selectQaCohorts,
  sha256,
  sha256File,
  summarizeCohort,
} = require("./library-full-pipeline-qa/selection.cjs");
const {
  buildComparisonMarkdown,
  compareRuns,
} = require("./library-full-pipeline-qa/comparison.cjs");
const {
  synchronizeQaRuntimeAssets,
} = require("./library-full-pipeline-qa/runtime-assets-preflight.cjs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(
  ROOT,
  "artifacts",
  "library-full-pipeline-font-qa-v7",
);
const DEFAULT_BOUNDARIES = [
  path.join(ROOT, "datasets", "font-matching-master-v2", "manifest.jsonl"),
  path.join(
    ROOT,
    "artifacts",
    "font-matching-training-export-full22-strict-v1",
  ),
  path.join(
    ROOT,
    "artifacts",
    "manga-font-student-human-overlay-adjudicated-val33-v1",
  ),
];
const FONT_MATCHING_RUNTIME_MARKER =
  ".font-matching-runtime-artifact-owned.json";

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "select") return selectCommand(parsed.options);
  if (parsed.command === "select-chapter")
    return selectChapterCommand(parsed.options);
  if (parsed.command === "inspect") return inspectCommand(parsed.options);
  if (parsed.command === "run") return runCommand(parsed.options);
  if (parsed.command === "compare") return compareCommand(parsed.options);
  if (parsed.command === "help") return printHelp();
  throw new Error(`Unknown command: ${parsed.command}`);
}

/** @param {Record<string, any>} options */
async function selectChapterCommand(options) {
  const workId = String(options["work-id"] || "").trim();
  const chapterId = String(options["chapter-id"] || "").trim();
  if (!workId || !chapterId) {
    throw new Error("select-chapter requires --work-id and --chapter-id.");
  }
  const libraryRoot = path.resolve(
    options.library || path.join(ROOT, "library"),
  );
  const outputRoot = path.resolve(options.output || DEFAULT_OUTPUT);
  const selectionPath = path.join(outputRoot, "selection.json");
  if (fs.existsSync(selectionPath)) {
    const existing = JSON.parse(await fsp.readFile(selectionPath, "utf8"));
    if (
      existing.chapterSelection?.workId !== workId ||
      existing.chapterSelection?.chapterId !== chapterId
    ) {
      throw new Error(
        `Existing immutable chapter selection targets a different chapter: ${selectionPath}`,
      );
    }
    console.log(`[font-qa] reusing immutable selection ${selectionPath}`);
    return;
  }
  const candidates = (await readLibraryCandidates(libraryRoot)).filter(
    (candidate) =>
      candidate.workId === workId && candidate.chapterId === chapterId,
  );
  if (candidates.length === 0) {
    throw new Error(`Library chapter not found: ${workId}/${chapterId}`);
  }
  candidates.sort((left, right) => left.pageIndex - right.pageIndex);
  const baseline = await materializeCohort(candidates, "baseline40");
  const manifestPath = path.join(outputRoot, "cohorts", "baseline40.jsonl");
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await writeJsonlExclusive(manifestPath, baseline);
  const selection = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    libraryRoot,
    chapterSelection: {
      policy: "explicit_user_requested_library_chapter",
      workId,
      chapterId,
    },
    cohorts: {
      baseline40: {
        manifestPath,
        manifestSha256: cohortDigest(baseline),
        ...summarizeCohort(baseline),
      },
    },
  };
  await writeJsonExclusive(selectionPath, selection);
  console.log(`[font-qa] wrote ${selectionPath}`);
  console.log(JSON.stringify(selection.cohorts.baseline40, null, 2));
}

/** @param {Record<string, any>} options */
async function selectCommand(options) {
  const libraryRoot = path.resolve(
    options.library || path.join(ROOT, "library"),
  );
  const outputRoot = path.resolve(options.output || DEFAULT_OUTPUT);
  const selectionPath = path.join(outputRoot, "selection.json");
  if (fs.existsSync(selectionPath)) {
    const existing = JSON.parse(await fsp.readFile(selectionPath, "utf8"));
    console.log(`[font-qa] reusing immutable selection ${selectionPath}`);
    console.log(JSON.stringify(existing.cohorts, null, 2));
    return;
  }
  const seed = String(options.seed || "font-qa-20260803-v6");
  const baselineCount = parsePositiveInteger(options.count || 40, "count");
  const holdoutCount = parsePositiveInteger(
    options["holdout-count"] || baselineCount,
    "holdout-count",
  );
  const boundaryInputs = stringList(options.boundary);
  const extraBoundaryInputs = stringList(options["extra-boundary"]);
  const workBoundaryInputs = stringList(options["work-boundary"]);
  const boundaries = [
    ...(boundaryInputs.length ? boundaryInputs : DEFAULT_BOUNDARIES),
    ...extraBoundaryInputs,
  ];
  const boundary = await scanTrainingBoundaries(boundaries);
  const workBoundary = await scanWorkBoundaries(workBoundaryInputs);
  const candidates = await readLibraryCandidates(libraryRoot);
  const excludedLibraryWorkIds = new Set(
    candidates
      .filter((candidate) => workBoundary.workIds.has(candidate.workId))
      .map((candidate) => candidate.workId),
  );
  const eligibleByWork = excludeWorkBoundaryOverlap(candidates, workBoundary);
  const eligibleByIdAndPath = excludeTrainingOverlap(eligibleByWork, boundary);
  const hashSafePool = await excludeTrainingShaOverlap(
    eligibleByIdAndPath,
    boundary,
  );
  const selected = selectQaCohorts(hashSafePool.candidates, {
    seed,
    baselineCount,
    holdoutCount,
  });
  const baseline = await materializeCohort(
    selected.baseline,
    "baseline40",
    hashSafePool.fileHashCache,
  );
  const holdout = await materializeCohort(
    selected.holdout,
    "holdout40",
    hashSafePool.fileHashCache,
  );
  await fsp.mkdir(path.join(outputRoot, "cohorts"), { recursive: true });
  const baselineManifest = path.join(outputRoot, "cohorts", "baseline40.jsonl");
  const holdoutManifest = path.join(outputRoot, "cohorts", "holdout40.jsonl");
  await writeJsonlExclusive(baselineManifest, baseline);
  await writeJsonlExclusive(holdoutManifest, holdout);
  const selection = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seed,
    libraryRoot,
    sourceBoundary: {
      policy:
        "exclude every source page referenced by the supplied training, validation, test, calibration, or labeling manifests",
      fileCount: boundary.files.length,
      recordsRead: boundary.recordsRead,
      excludedPageIds: boundary.pageIds.size,
      excludedRelativePaths: boundary.relativePaths.size,
      excludedSourcePageSha256s: boundary.sourcePageSha256s.size,
      bindingSha256: sha256(
        boundary.files.map((file) => `${file.path}:${file.sha256}`).join("\n"),
      ),
      files: boundary.files,
    },
    workBoundary: {
      policy:
        "exclude every library page belonging to a work referenced by a supplied work-boundary JSON or JSONL record",
      acceptedRecordShapes: ["work_id", "workId", "work.id"],
      fileCount: workBoundary.files.length,
      recordsRead: workBoundary.recordsRead,
      excludedWorkCount: workBoundary.workIds.size,
      matchedLibraryWorkCount: excludedLibraryWorkIds.size,
      excludedLibraryPages: candidates.length - eligibleByWork.length,
      bindingSha256: boundaryFilesBindingSha256(workBoundary.files),
      files: workBoundary.files,
    },
    cohortSelection: {
      algorithmVersion: "joint-interleaved-work-diversity-v1",
      policy:
        "allocate baseline and holdout together, maximize per-cohort work coverage before adding concentration, and preserve global page/chapter disjointness",
      pageDisjointAcrossCohorts: true,
      chapterDisjointAcrossCohorts: true,
      variantReservationFraction: 0.5,
    },
    candidatePool: {
      libraryPages: candidates.length,
      eligibleNonTrainingPages: hashSafePool.candidates.length,
      excludedByWorkBoundary: candidates.length - eligibleByWork.length,
      excludedWorksByWorkBoundary: excludedLibraryWorkIds.size,
      excludedByIdOrPath: eligibleByWork.length - eligibleByIdAndPath.length,
      excludedBySourcePageSha256: hashSafePool.excludedBySha,
    },
    cohorts: {
      baseline40: {
        manifestPath: baselineManifest,
        manifestSha256: cohortDigest(baseline),
        ...summarizeCohort(baseline),
      },
      holdout40: {
        manifestPath: holdoutManifest,
        manifestSha256: cohortDigest(holdout),
        accessPolicy: "reserved_until_baseline_iteration_is_accepted",
        ...summarizeCohort(holdout),
      },
    },
  };
  await writeJsonExclusive(selectionPath, selection);
  console.log(`[font-qa] wrote ${selectionPath}`);
  console.log(JSON.stringify(selection.cohorts, null, 2));
}

/** @param {Awaited<ReturnType<typeof readLibraryCandidates>>} candidates @param {Awaited<ReturnType<typeof scanTrainingBoundaries>>} boundary */
async function excludeTrainingShaOverlap(candidates, boundary) {
  const fileHashCache = new Map();
  const acceptedByIndex = new Array(candidates.length);
  let excludedBySha = 0;
  let nextIndex = 0;
  const workerCount = Math.min(8, Math.max(1, candidates.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < candidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        const candidate = candidates[index];
        if (!candidate) continue;
        const resolvedImagePath = path.resolve(candidate.imagePath);
        const digest = await sha256File(resolvedImagePath);
        fileHashCache.set(resolvedImagePath, digest);
        if (boundary.sourcePageSha256s.has(digest)) excludedBySha += 1;
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

/** @param {Record<string, any>} options */
async function inspectCommand(options) {
  const outputRoot = path.resolve(options.output || DEFAULT_OUTPUT);
  const selection = JSON.parse(
    await fsp.readFile(path.join(outputRoot, "selection.json"), "utf8"),
  );
  const boundaries = stringList(options.boundary);
  const boundary = await scanTrainingBoundaries(
    boundaries.length
      ? boundaries
      : selection.sourceBoundary.files.map((file) => file.path),
  );
  const workBoundarySeal = selection.workBoundary ?? null;
  const workBoundary = await scanWorkBoundaries(
    workBoundarySeal ? sealedBoundaryFilePaths(workBoundarySeal) : [],
  );
  const workBoundaryErrors = validateWorkBoundarySeal(
    workBoundarySeal,
    workBoundary,
  );
  const results = {};
  for (const cohort of ["baseline40", "holdout40"]) {
    const details = selection.cohorts[cohort];
    const records = await readJsonl(details.manifestPath);
    const errors = [];
    if (cohortDigest(records) !== details.manifestSha256) {
      errors.push("manifest_digest_mismatch");
    }
    for (const record of records) {
      const recordWorkId =
        typeof record.work?.id === "string" ? record.work.id.trim() : "";
      if (!recordWorkId) {
        errors.push(`missing_work_id:${record.page?.id || "unknown"}`);
      } else if (workBoundary.workIds.has(recordWorkId)) {
        errors.push(`work_boundary_work_id:${recordWorkId}`);
      }
      if (boundary.pageIds.has(record.page.id))
        errors.push(`training_page_id:${record.page.id}`);
      if (boundary.relativePaths.has(record.page.imageRelativePath)) {
        errors.push(`training_page_path:${record.page.imageRelativePath}`);
      }
      const actual = await sha256File(record.page.imagePath);
      if (actual !== record.page.imageSha256)
        errors.push(`image_changed:${record.page.id}`);
      if (boundary.sourcePageSha256s.has(actual))
        errors.push(`training_page_sha:${record.page.id}`);
    }
    results[cohort] = { records: records.length, errors };
  }
  const ok =
    Object.values(results).every((result) => result.errors.length === 0) &&
    workBoundaryErrors.length === 0;
  console.log(
    JSON.stringify(
      {
        ok,
        workBoundary: {
          files: workBoundary.files.length,
          recordsRead: workBoundary.recordsRead,
          excludedWorks: workBoundary.workIds.size,
          errors: workBoundaryErrors,
        },
        cohorts: results,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
}

/** @param {any} seal */
function sealedBoundaryFilePaths(seal) {
  if (!seal || !Array.isArray(seal.files)) {
    throw new Error("selection.json workBoundary.files must be an array");
  }
  return seal.files.map((file, index) => {
    if (!file || typeof file.path !== "string" || !file.path.trim()) {
      throw new Error(`selection.json workBoundary.files[${index}] is invalid`);
    }
    return file.path;
  });
}

/**
 * @param {any} seal
 * @param {Awaited<ReturnType<typeof scanWorkBoundaries>>} boundary
 */
function validateWorkBoundarySeal(seal, boundary) {
  if (!seal) return [];
  const errors = [];
  if (seal.fileCount !== boundary.files.length) {
    errors.push("work_boundary_file_count_mismatch");
  }
  if (seal.recordsRead !== boundary.recordsRead) {
    errors.push("work_boundary_records_read_mismatch");
  }
  if (seal.excludedWorkCount !== boundary.workIds.size) {
    errors.push("work_boundary_excluded_work_count_mismatch");
  }
  if (seal.bindingSha256 !== boundaryFilesBindingSha256(boundary.files)) {
    errors.push("work_boundary_binding_mismatch");
  }
  return errors;
}

/** @param {Array<{ path: string; sha256: string }>} files */
function boundaryFilesBindingSha256(files) {
  return sha256(files.map((file) => `${file.path}:${file.sha256}`).join("\n"));
}

/** @param {Record<string, any>} options */
async function runCommand(options) {
  const config = await resolveRunCommandConfig(options);
  if (!config.execute) {
    console.log(
      "[font-qa] DRY RUN: OCR, translation, inpainting, and rendering were not started.",
    );
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  assertCompiledRuntime();
  const electronExe = ensureElectronExecutable(ROOT);
  const electronScript = path.join(
    ROOT,
    "scripts",
    "library-full-pipeline-qa",
    "electron-runner.cjs",
  );
  const env = {
    ...process.env,
    MGT_LIBRARY_FONT_QA_CONFIG: JSON.stringify(config),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronExe, [electronScript], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}

/** @param {Record<string, any>} options */
async function resolveRunCommandConfig(options) {
  if (
    options["page-limit"] !== undefined &&
    options["selection-index"] !== undefined
  ) {
    throw new Error("--page-limit and --selection-index cannot be combined.");
  }
  const outputRoot = path.resolve(options.output || DEFAULT_OUTPUT);
  const cohort = String(options.cohort || "baseline40");
  assertRunnableCohort(cohort, Boolean(options["allow-holdout"]));
  const selection = JSON.parse(
    await fsp.readFile(path.join(outputRoot, "selection.json"), "utf8"),
  );
  const manifestPath = selection.cohorts[cohort]?.manifestPath;
  if (!manifestPath) throw new Error(`Missing cohort manifest: ${cohort}`);
  const candidateId = sanitizeId(
    options["candidate-id"] || "installed-runtime",
  );
  const runtimeDir = path.resolve(
    options["runtime-dir"] ||
      path.join(ROOT, "out", "app-runtime", "font-matching"),
  );
  const cacheFrom = options["cache-from"]
    ? path.resolve(options["cache-from"])
    : null;
  const ocrCacheFrom = options["ocr-cache-from"]
    ? path.resolve(options["ocr-cache-from"])
    : null;
  const fontInferenceCacheMode = resolveFontInferenceCacheMode(
    options,
    cacheFrom,
  );
  const qaPageRelativeRoleReroute = resolveQaPageRelativeRoleReroute(
    options,
    fontInferenceCacheMode,
  );
  const qaModelDirectSelection = resolveQaModelDirectSelection(
    options,
    cacheFrom,
    fontInferenceCacheMode,
  );
  const cacheFromSeal = resolveCacheFromSeal(
    options,
    cacheFrom,
    fontInferenceCacheMode,
    qaPageRelativeRoleReroute,
  );
  const runId = sanitizeId(
    options["run-id"] || new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const runDir = path.join(outputRoot, "runs", cohort, candidateId, runId);
  const execute = Boolean(options.execute || options.preflight);
  const allowQaOnlyRuntime = Boolean(options["allow-qa-only-runtime"]);
  if (execute && fs.existsSync(runDir)) {
    throw new Error(`Run directory already exists: ${runDir}`);
  }
  if (execute) {
    const runtimeAssets = synchronizeQaRuntimeAssets(ROOT);
    console.log(
      `[font-qa] runtime assets ${runtimeAssets.status}: ${runtimeAssets.reason}`,
    );
  }
  const runtimeRelease = await resolveRuntimeReleaseForQa({
    runtimeDir,
    execute,
    allowQaOnlyRuntime,
  });
  const config = {
    root: ROOT,
    outputRoot,
    runDir,
    runId,
    cohort,
    cohortDigest: selection.cohorts[cohort].manifestSha256,
    manifestPath,
    candidateId,
    runtimeDir,
    cacheFrom,
    ocrCacheFrom,
    cacheFromSeal,
    fontInferenceCacheMode,
    qaModelDirectSelection,
    qaPageRelativeRoleReroute,
    execute,
    preflightOnly: Boolean(options.preflight),
    allowPaidProvider: Boolean(options["allow-paid-provider"]),
    allowHoldout: Boolean(options["allow-holdout"]),
    allowQaOnlyRuntime,
    qaOnlyRuntime: runtimeRelease?.qaOnly ?? null,
    pageLimit: options["page-limit"]
      ? parsePositiveInteger(options["page-limit"], "page-limit")
      : null,
    selectionIndex:
      options["selection-index"] !== undefined
        ? parseNonNegativeInteger(options["selection-index"], "selection-index")
        : null,
  };
  return config;
}

/** @param {string} cohort @param {boolean} allowHoldout */
function assertRunnableCohort(cohort, allowHoldout) {
  if (!new Set(["baseline40", "holdout40"]).has(cohort)) {
    throw new Error("cohort must be baseline40 or holdout40");
  }
  if (cohort === "holdout40" && !allowHoldout) {
    throw new Error(
      "The fresh holdout40 is reserved. Pass --allow-holdout only after accepting a baseline iteration.",
    );
  }
}

/**
 * @param {{ runtimeDir: string; execute: boolean; allowQaOnlyRuntime: boolean }} options
 */
async function resolveRuntimeReleaseForQa(options) {
  if (!options.execute) return null;
  const runtimeRelease = await readFontMatchingRuntimeReleaseMarker(
    options.runtimeDir,
  );
  assertFontMatchingRuntimeReleaseAllowed(
    runtimeRelease,
    options.allowQaOnlyRuntime,
  );
  return runtimeRelease;
}

/**
 * @param {{ qaOnly: boolean; releaseApproved: boolean }} runtimeRelease
 * @param {boolean} allowQaOnlyRuntime
 */
function assertFontMatchingRuntimeReleaseAllowed(
  runtimeRelease,
  allowQaOnlyRuntime,
) {
  if (runtimeRelease.qaOnly && !allowQaOnlyRuntime) {
    throw new Error(
      "QA-only font runtime is not release-approved. Pass --allow-qa-only-runtime only for frozen library QA.",
    );
  }
}

/** @param {string} runtimeDir */
async function readFontMatchingRuntimeReleaseMarker(runtimeDir) {
  const markerPath = path.join(runtimeDir, FONT_MATCHING_RUNTIME_MARKER);
  let marker;
  try {
    marker = JSON.parse(await fsp.readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Font runtime ownership marker is unreadable: ${markerPath}`,
      {
        cause: error,
      },
    );
  }
  return classifyFontMatchingRuntimeReleaseMarker(marker);
}

/** @param {unknown} marker */
function classifyFontMatchingRuntimeReleaseMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new Error("Font runtime ownership marker must be an object.");
  }
  const hasQaOnly = Object.hasOwn(marker, "qa_only");
  const hasReleaseApproved = Object.hasOwn(marker, "release_approved");
  if (!hasQaOnly && !hasReleaseApproved) {
    return { qaOnly: false, releaseApproved: true };
  }
  if (
    !hasQaOnly ||
    !hasReleaseApproved ||
    marker.qa_only !== true ||
    marker.release_approved !== false
  ) {
    throw new Error(
      "Font runtime QA-only marker flags must be exactly qa_only=true and release_approved=false.",
    );
  }
  return { qaOnly: true, releaseApproved: false };
}

/** @param {Record<string, any>} options */
async function compareCommand(options) {
  if (!options.baseline || !options.candidate) {
    throw new Error(
      "compare requires --baseline <run-dir> and --candidate <run-dir>",
    );
  }
  const report = await compareRuns(
    path.resolve(options.baseline),
    path.resolve(options.candidate),
  );
  const outputDir = path.resolve(
    options.output || path.join(path.resolve(options.candidate), "comparison"),
  );
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, "comparison.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await fsp.writeFile(
    path.join(outputDir, "comparison.md"),
    buildComparisonMarkdown(report),
    "utf8",
  );
  console.log(`[font-qa] wrote ${outputDir}`);
}

function assertCompiledRuntime() {
  const required = [
    "out/main/wholePagePipeline.js",
    "out/main/inpainting/patternPage.js",
    "out/main/pageExport.js",
    "out/main/pipeline/fontMatchingPagePixelInference.js",
  ];
  const missing = required.filter(
    (relative) => !fs.existsSync(path.join(ROOT, relative)),
  );
  if (missing.length) {
    throw new Error(
      `Compiled runtime is missing (${missing.join(", ")}). Run npm run compile:electron.`,
    );
  }
}

/** @param {string} filePath @param {any[]} records */
async function writeJsonlExclusive(filePath, records) {
  await fsp.writeFile(
    filePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    { encoding: "utf8", flag: "wx" },
  );
}

/** @param {string} filePath @param {unknown} value */
async function writeJsonExclusive(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

/** @param {string} filePath */
async function readJsonl(filePath) {
  return (await fsp.readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const options = {};
  const optionStart = argv[0] && !argv[0].startsWith("-") ? 1 : 0;
  for (let index = optionStart; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (value !== true) index += 1;
    if (options[key] === undefined) options[key] = value;
    else options[key] = [...stringList(options[key]), String(value)];
  }
  return { command, options };
}

/** @param {unknown} value */
function stringList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === false) return [];
  return [String(value)];
}

/** @param {unknown} value @param {string} label */
function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

/** @param {unknown} value @param {string} label */
function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

/** @param {unknown} value */
function sanitizeId(value) {
  const result = String(value || "run")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!result || result === "." || result === "..")
    throw new Error("Invalid id");
  return result;
}

function parseFontInferenceCacheMode(value) {
  if (value === undefined || value === null || value === false) return "off";
  if (value === "required") return value;
  throw new Error("--reuse-cached-font-inference must be required.");
}

function resolveFontInferenceCacheMode(options, cacheFrom) {
  const mode = parseFontInferenceCacheMode(
    options["reuse-cached-font-inference"],
  );
  if (mode !== "off" && !cacheFrom) {
    throw new Error("--reuse-cached-font-inference requires --cache-from.");
  }
  if (mode !== "off" && options.preflight) {
    throw new Error(
      "--reuse-cached-font-inference is unavailable for preflight-only runs.",
    );
  }
  return mode;
}

function resolveQaPageRelativeRoleReroute(options, fontInferenceCacheMode) {
  const enabled = options["qa-page-relative-role-reroute"] === true;
  if (enabled && fontInferenceCacheMode !== "off") {
    throw new Error(
      "--qa-page-relative-role-reroute requires live font inference; remove --reuse-cached-font-inference.",
    );
  }
  return enabled;
}

function resolveQaModelDirectSelection(
  options,
  cacheFrom,
  fontInferenceCacheMode,
) {
  const enabled = options["qa-model-direct-selection"] === true;
  if (enabled && (!cacheFrom || fontInferenceCacheMode !== "off")) {
    throw new Error(
      "--qa-model-direct-selection requires a live font replay with --cache-from.",
    );
  }
  return enabled;
}

function resolveCacheFromSeal(
  options,
  cacheFrom,
  fontInferenceCacheMode,
  qaPageRelativeRoleReroute,
) {
  const seal = options["cache-from-seal"]
    ? path.resolve(String(options["cache-from-seal"]))
    : null;
  if (seal && !cacheFrom) {
    throw new Error("--cache-from-seal requires --cache-from.");
  }
  if (cacheFrom && fontInferenceCacheMode === "off" && !seal) {
    throw new Error(
      "Live font replay requires --cache-from-seal from the fresh-Gemma baseline.",
    );
  }
  if (qaPageRelativeRoleReroute && (!cacheFrom || !seal)) {
    throw new Error(
      "--qa-page-relative-role-reroute requires --cache-from and --cache-from-seal.",
    );
  }
  if (
    qaPageRelativeRoleReroute &&
    (options["page-limit"] !== undefined ||
      options["selection-index"] !== undefined)
  ) {
    throw new Error(
      "--qa-page-relative-role-reroute requires the complete 40-page cohort; remove --page-limit and --selection-index.",
    );
  }
  return seal;
}

function printHelp() {
  console.log(
    `Library full-pipeline font QA (no computer-use)\n\n` +
      `  select  Freeze non-training baseline40 and fresh holdout40 manifests\n` +
      `  select-chapter Freeze every page of one explicitly requested library chapter\n` +
      `  inspect Re-hash and verify both frozen cohorts\n` +
      `  run     Dry-run by default; add --execute for the real app pipeline\n` +
      `  compare Compare two completed runs over the same cohort\n\n` +
      `Examples:\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs select\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs select-chapter --work-id <id> --chapter-id <id> --output <dir>\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs select --output <next-round> --seed <new-seed> --extra-boundary <previous-cohort.jsonl>\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs select --work-boundary <training-overlay.jsonl> [--work-boundary <more.json>]\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id v2\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id v2 --execute\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id qat --ocr-cache-from <baseline-run> --execute\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id qa-v2 --runtime-dir <qa-runtime> --allow-qa-only-runtime --preflight\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id qa-v2 --selection-index 8 --cache-from <fresh-run> --cache-from-seal <fresh-run-audit.json> --execute\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id v3 --cache-from <v2-run> --cache-from-seal <fresh-run-audit.json> --execute\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id v4 --cache-from <v3-run> --reuse-cached-font-inference required --execute\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id page-role-qa --cache-from <fresh-run> --cache-from-seal <fresh-run-audit.json> --qa-page-relative-role-reroute --execute\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs run --cohort baseline40 --candidate-id model-direct-qa --selection-index 8 --cache-from <fresh-run> --cache-from-seal <fresh-run-audit.json> --qa-model-direct-selection --execute\n` +
      `  node scripts/run-library-full-pipeline-qa.cjs compare --baseline <run> --candidate <run>`,
  );
}

module.exports = {
  assertFontMatchingRuntimeReleaseAllowed,
  classifyFontMatchingRuntimeReleaseMarker,
  parseArguments,
  parseFontInferenceCacheMode,
  resolveCacheFromSeal,
  resolveQaPageRelativeRoleReroute,
  readFontMatchingRuntimeReleaseMarker,
  sanitizeId,
};
