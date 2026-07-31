// @ts-check
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { ensureElectronExecutable } = require("./electron-executable.cjs");
const {
  OWNER,
  REPORT_VERSION,
  SCHEMA_VERSION,
  buildRenderPlan,
  publicJobSpec,
  serializeJson,
  sha256,
} = require("./font-render-bank/spec.cjs");
const {
  MARKER_FILE,
  assertChildPath,
  assertOwnedOutput,
  assertReplaceableOutput,
  createRunDirectory,
  createStagingDirectory,
  listFiles,
  readJson,
  readPngDimensions,
  replaceOutputDirectory,
  tryRemoveOwnedTemporaryAsync,
} = require("./font-render-bank/output.cjs");

const MANIFEST_FILE = "manifest.json";
const REPORT_FILE = "report.json";

/** @typedef {{check: boolean; help: boolean; limit: number | null; output: string | null}} CliArguments */
/**
 * @typedef {{
 *   ok: boolean;
 *   error?: string;
 *   renderer?: Record<string, unknown>;
 *   renders: Array<Record<string, any>>;
 * }} RunnerResult
 */

/** @param {string} root @param {string} outputDirectory @param {number | null} limit */
async function writeArtifacts(root, outputDirectory, limit) {
  assertReplaceableOutput(outputDirectory);
  const plan = buildRenderPlan(root, { limit });
  const stagingDirectory = createStagingDirectory(outputDirectory);
  const runDirectory = createRunDirectory(root);
  let completed = false;
  try {
    const runnerResult = runElectronRenderer(
      root,
      runDirectory,
      stagingDirectory,
      plan,
    );
    const artifacts = assembleArtifacts(
      root,
      stagingDirectory,
      plan,
      runnerResult,
    );
    persistMetadata(stagingDirectory, artifacts);
    verifyOutput(root, stagingDirectory, limit);
    await replaceOutputDirectory(outputDirectory, stagingDirectory);
    completed = true;
    return artifacts;
  } finally {
    if (completed) {
      await tryRemoveOwnedTemporaryAsync(runDirectory, join(root, ".tmp"));
    } else {
      console.warn(`[font-render-bank] failed run kept at ${runDirectory}`);
    }
    if (!completed) {
      await tryRemoveOwnedTemporaryAsync(
        stagingDirectory,
        dirname(outputDirectory),
      );
    }
  }
}

/** @param {string} root @param {string} outputDirectory @param {number | null} expectedLimit */
function verifyOutput(root, outputDirectory, expectedLimit = null) {
  assertOwnedOutput(outputDirectory);
  const manifestBytes = readFileSync(join(outputDirectory, MANIFEST_FILE));
  const reportBytes = readFileSync(join(outputDirectory, REPORT_FILE));
  const marker = readJson(join(outputDirectory, MARKER_FILE));
  const manifest = readJson(join(outputDirectory, MANIFEST_FILE));
  const report = readJson(join(outputDirectory, REPORT_FILE));
  assertMetadataHashes(marker, manifestBytes, report, reportBytes);
  assertManifestContract(root, manifest, expectedLimit);
  assertRenderArtifacts(outputDirectory, manifest);
  assertOutputFileSet(outputDirectory, manifest);
  return { manifest, report };
}

/** @param {string} root @param {Record<string, any>} manifest @param {number | null} expectedLimit */
function assertManifestContract(root, manifest, expectedLimit) {
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Unexpected font render-bank schema: ${manifest.schema_version}.`,
    );
  }
  const recordedLimit = manifest.generation?.limit ?? null;
  if (expectedLimit !== null && recordedLimit !== expectedLimit) {
    throw new Error(
      `Font render-bank limit mismatch: expected ${expectedLimit}, found ${recordedLimit}.`,
    );
  }
  const currentPlan = buildRenderPlan(root, { limit: recordedLimit });
  if (manifest.specification_sha256 !== currentPlan.specification_sha256) {
    throw new Error("Font render-bank specification is stale.");
  }
  const expectedInputs = buildInputs(root, currentPlan);
  if (serializeJson(manifest.inputs) !== serializeJson(expectedInputs)) {
    throw new Error("Font render-bank source inputs are stale.");
  }
  const expectedIds = currentPlan.jobs.map((job) => job.render_id);
  const recordedIds = manifest.renders.map(
    (/** @type {Record<string, any>} */ render) => render.render_id,
  );
  if (serializeJson(recordedIds) !== serializeJson(expectedIds)) {
    throw new Error("Font render-bank render inventory is stale.");
  }
  if (
    manifest.family_count !== 15 ||
    manifest.face_count !== 31 ||
    manifest.candidate_count !== currentPlan.candidates.length
  ) {
    throw new Error(
      "Font render-bank family/face/candidate counts are invalid.",
    );
  }
  assertCandidateAliases(manifest.candidates);
}

/** @param {Record<string, any>} marker @param {Buffer} manifestBytes @param {Record<string, any>} report @param {Buffer} reportBytes */
function assertMetadataHashes(marker, manifestBytes, report, reportBytes) {
  const manifestSha = sha256(manifestBytes);
  const reportSha = sha256(reportBytes);
  if (
    marker.owner !== OWNER ||
    marker.schema_version !== SCHEMA_VERSION ||
    marker.manifest_sha256 !== manifestSha ||
    marker.report_sha256 !== reportSha ||
    report.schema_version !== REPORT_VERSION ||
    report.manifest_sha256 !== manifestSha
  ) {
    throw new Error(
      "Font render-bank manifest/report checksum contract failed.",
    );
  }
}

/** @param {string} outputDirectory @param {Record<string, any>} manifest */
function assertRenderArtifacts(outputDirectory, manifest) {
  for (const render of manifest.renders) {
    const artifact = render.artifact;
    const imagePath = resolve(
      outputDirectory,
      ...String(artifact.file).split("/"),
    );
    assertChildPath(imagePath, outputDirectory);
    const bytes = readFileSync(imagePath);
    const dimensions = readPngDimensions(bytes);
    if (
      sha256(bytes) !== artifact.sha256 ||
      bytes.length !== artifact.byte_size ||
      dimensions.width !== artifact.width ||
      dimensions.height !== artifact.height ||
      artifact.qa_overlay !== false ||
      render.readiness?.document_fonts_ready !== true ||
      render.fallback_detection?.status !== "passed"
    ) {
      throw new Error(`Font render artifact check failed: ${artifact.file}.`);
    }
  }
}

/** @param {string} outputDirectory @param {Record<string, any>} manifest */
function assertOutputFileSet(outputDirectory, manifest) {
  const expected = new Set([
    MARKER_FILE,
    MANIFEST_FILE,
    REPORT_FILE,
    ...manifest.renders.map(
      (/** @type {Record<string, any>} */ render) => render.artifact.file,
    ),
  ]);
  const actual = new Set(listFiles(outputDirectory));
  const missing = [...expected].filter((file) => !actual.has(file));
  const unexpected = [...actual].filter((file) => !expected.has(file));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Font render-bank file inventory mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}.`,
    );
  }
}

/** @param {string} root @param {string} runDirectory @param {string} outputDirectory @param {ReturnType<typeof buildRenderPlan>} plan */
function runElectronRenderer(root, runDirectory, outputDirectory, plan) {
  const inputPath = join(runDirectory, "input.json");
  const resultPath = join(runDirectory, "result.json");
  const runnerPath = join(
    root,
    "scripts",
    "font-render-bank",
    "electron-runner.cjs",
  );
  const input = {
    schema_version: SCHEMA_VERSION,
    render_spec: plan.render_spec,
    candidates: plan.candidates,
    jobs: plan.jobs,
  };
  writeFileSync(inputPath, serializeJson(input), "utf8");
  const electronExecutable = ensureElectronExecutable(root);
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    MGT_FONT_BANK_ROOT: root,
    MGT_FONT_BANK_RUN_ROOT: runDirectory,
    MGT_FONT_BANK_INPUT: inputPath,
    MGT_FONT_BANK_RESULT: resultPath,
    MGT_FONT_BANK_OUTPUT: outputDirectory,
    MGT_FONT_BANK_USER_DATA: join(runDirectory, "electron-user-data"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electronExecutable, [runnerPath], {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: Math.max(120_000, plan.jobs.length * 5_000),
    windowsHide: true,
  });
  if (child.error) throw child.error;
  const result = existsSync(resultPath)
    ? /** @type {RunnerResult} */ (readJson(resultPath))
    : { error: "Electron runner produced no result.", ok: false, renders: [] };
  if (child.signal || child.status !== 0 || !result.ok) {
    throw new Error(
      `Font renderer failed${child.signal ? ` (${child.signal})` : ""}: ${result.error ?? `exit ${child.status}`}`,
    );
  }
  if (result.renders.length !== plan.jobs.length || !result.renderer) {
    throw new Error("Font renderer returned an incomplete render inventory.");
  }
  return result;
}

/** @param {string} root @param {string} stagingDirectory @param {ReturnType<typeof buildRenderPlan>} plan @param {RunnerResult} result */
function assembleArtifacts(root, stagingDirectory, plan, result) {
  const renderer = result.renderer;
  if (!renderer) throw new Error("Font renderer metadata is missing.");
  const resultById = new Map(
    result.renders.map((render) => [String(render.render_id), render]),
  );
  const renders = plan.jobs.map((job) => {
    const rendered = resultById.get(job.render_id);
    if (!rendered) throw new Error(`Missing renderer result ${job.render_id}.`);
    const imagePath = resolve(stagingDirectory, ...job.image_file.split("/"));
    assertChildPath(imagePath, stagingDirectory);
    const bytes = readFileSync(imagePath);
    const dimensions = readPngDimensions(bytes);
    return {
      ...publicJobSpec(job),
      readiness: rendered.readiness,
      fallback_detection: rendered.fallback_detection,
      computed_style: rendered.computed_style,
      pixels: rendered.pixels,
      artifact: {
        file: job.image_file,
        sha256: sha256(bytes),
        byte_size: bytes.length,
        width: dimensions.width,
        height: dimensions.height,
        qa_overlay: false,
      },
    };
  });
  const manifest = {
    schema_version: SCHEMA_VERSION,
    deterministic_specification: true,
    specification_sha256: plan.specification_sha256,
    inputs: buildInputs(root, plan),
    source_contract: {
      schema_version: plan.source_face_manifest.schema_version,
      manifest_sha256: plan.source_face_manifest_sha256,
    },
    renderer: normalizeRenderer(renderer),
    candidate_identity_contract: {
      display_id_field: "candidate_display_id",
      blind_alias_field: "blind_alias",
      image_paths_expose_font_identity: false,
    },
    render_spec: plan.render_spec,
    probe_bank: plan.probes,
    generation: {
      limit: plan.limit,
      partial: plan.limit !== null,
      expected_render_count: plan.expected_render_count,
      full_render_count: plan.full_render_count,
      production_asset_omitted_render_count:
        plan.expected_render_count - plan.full_render_count,
      complete_against_production_assets:
        plan.limit === null &&
        plan.expected_render_count === plan.full_render_count,
      rendered_count: renders.length,
    },
    family_count: plan.source_face_manifest.family_count,
    face_count: plan.source_face_manifest.face_count,
    candidate_count: plan.candidates.length,
    rendered_candidate_count: new Set(
      renders.map((render) => render.candidate_display_id),
    ).size,
    candidates: plan.candidates.map(publicCandidate),
    renders,
  };
  const serializedManifest = serializeJson(manifest);
  const report = buildReport(manifest, sha256(Buffer.from(serializedManifest)));
  return {
    manifest,
    report,
    serializedManifest,
    serializedReport: serializeJson(report),
  };
}

/** @param {Record<string, any>} manifest @param {string} manifestSha256 */
function buildReport(manifest, manifestSha256) {
  const byRole = countBy(manifest.renders, "role");
  const byWritingMode = countBy(manifest.renders, "writing_mode");
  const fallbackPassed = manifest.renders.filter(
    (/** @type {Record<string, any>} */ render) =>
      render.fallback_detection.status === "passed",
  ).length;
  const unrenderableCandidates = manifest.candidates.filter(
    (/** @type {Record<string, any>} */ candidate) =>
      candidate.production_asset_status.chromium_ots_compatible === false,
  );
  const unrenderableFaces = [
    ...new Map(
      unrenderableCandidates.map(
        (/** @type {Record<string, any>} */ candidate) => [
          candidate.face_id,
          {
            font_id: candidate.font_id,
            face_id: candidate.face_id,
            source_file: candidate.source_file,
            source_sha256: candidate.source_sha256,
            zero_length_tables:
              candidate.production_asset_status.zero_length_tables,
            chromium_evidence: candidate.production_asset_status.evidence,
          },
        ],
      ),
    ).values(),
  ];
  return {
    schema_version: REPORT_VERSION,
    manifest_schema_version: manifest.schema_version,
    manifest_sha256: manifestSha256,
    summary: {
      family_count: manifest.family_count,
      face_count: manifest.face_count,
      candidate_count: manifest.candidate_count,
      rendered_candidate_count: manifest.rendered_candidate_count,
      rendered_png_count: manifest.renders.length,
      fonts_ready_pass_count: manifest.renders.filter(
        (/** @type {Record<string, any>} */ render) =>
          render.readiness.document_fonts_ready === true,
      ).length,
      fallback_detection_pass_count: fallbackPassed,
      qa_overlay_png_count: 0,
      production_unrenderable_face_count: unrenderableFaces.length,
      production_unrenderable_candidate_count: unrenderableCandidates.length,
      production_asset_omitted_png_count:
        manifest.generation.production_asset_omitted_render_count,
    },
    cohorts: {
      by_role: byRole,
      by_writing_mode: byWritingMode,
      production_unrenderable_faces: unrenderableFaces,
    },
    findings: [
      ...(unrenderableFaces.length > 0
        ? [
            {
              code: "PRODUCTION_FONT_REJECTED_BY_CHROMIUM_OTS",
              severity: "error",
              count: unrenderableFaces.length,
              detail:
                "The original production assets are omitted, not silently normalized: Chromium reports `OTS parsing error: TSI3: zero-length table`. Replace or explicitly exclude these exact source faces before a 31-face bank can be complete.",
            },
          ]
        : []),
      ...(manifest.generation.partial
        ? [
            {
              code: "LIMITED_FIXTURE",
              severity: "info",
              detail: `This is a deterministic ${manifest.generation.rendered_count}/${manifest.generation.full_render_count} render fixture.`,
            },
          ]
        : []),
    ],
  };
}

/** @param {string} root @param {ReturnType<typeof buildRenderPlan>} plan */
function buildInputs(root, plan) {
  const paths = [
    "scripts/build-font-render-bank.cjs",
    "scripts/font-render-bank/spec.cjs",
    "scripts/font-render-bank/output.cjs",
    "scripts/font-render-bank/electron-runner.cjs",
    "src/renderer/src/styles/fonts.css",
  ];
  return [
    {
      path: "datasets/fontclip-font-catalog-v1/manifest.json (derived)",
      sha256: plan.source_face_manifest_sha256,
    },
    ...paths.map((path) => ({
      path,
      sha256: sha256(readFileSync(join(root, ...path.split("/")))),
    })),
  ];
}

/** @param {Record<string, any>} renderer */
function normalizeRenderer(renderer) {
  return {
    engine: renderer.engine,
    electron_version: renderer.electron_version,
    chrome_version: renderer.chrome_version,
    device_scale_factor: renderer.device_scale_factor,
    hardware_acceleration: renderer.hardware_acceleration,
    production_stylesheet: "src/renderer/src/styles/fonts.css",
    production_stylesheet_loaded_via: "isolated-local-http-link",
  };
}

/** @param {Record<string, any>} candidate */
function publicCandidate(candidate) {
  const { browser_family_alias: _browserAlias, ...publicValue } = candidate;
  return publicValue;
}

/** @param {Array<Record<string, any>>} rows @param {string} key */
function countBy(rows, key) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of rows) {
    const value = String(row[key]);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** @param {string} outputDirectory @param {ReturnType<typeof assembleArtifacts>} artifacts */
function persistMetadata(outputDirectory, artifacts) {
  writeFileSync(
    join(outputDirectory, MANIFEST_FILE),
    artifacts.serializedManifest,
    "utf8",
  );
  writeFileSync(
    join(outputDirectory, REPORT_FILE),
    artifacts.serializedReport,
    "utf8",
  );
  const marker = {
    owner: OWNER,
    schema_version: SCHEMA_VERSION,
    manifest_sha256: sha256(Buffer.from(artifacts.serializedManifest)),
    report_sha256: sha256(Buffer.from(artifacts.serializedReport)),
    safe_replace: true,
  };
  writeFileSync(
    join(outputDirectory, MARKER_FILE),
    serializeJson(marker),
    "utf8",
  );
}

/** @param {Array<Record<string, any>>} candidates */
function assertCandidateAliases(candidates) {
  const displayIds = candidates.map((candidate) => candidate.display_id);
  const aliases = candidates.map((candidate) => candidate.blind_alias);
  if (
    new Set(displayIds).size !== candidates.length ||
    new Set(aliases).size !== candidates.length ||
    candidates.some(
      (candidate) =>
        candidate.display_id === candidate.blind_alias ||
        !/^ko-candidate-[0-9a-f]{16}$/.test(candidate.blind_alias),
    )
  ) {
    throw new Error(
      "Candidate display IDs and blind aliases are not separated.",
    );
  }
}

/** @param {string[]} argv @returns {CliArguments} */
function parseArguments(argv) {
  /** @type {CliArguments} */
  const output = { check: false, help: false, limit: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") output.check = true;
    else if (argument === "--help") output.help = true;
    else if (argument === "--output") {
      output.output = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("--limit must be a positive integer.");
      }
      output.limit = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}.`);
  }
  return output;
}

async function main() {
  const root = resolve(__dirname, "..");
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/build-font-render-bank.cjs [--check] [--limit COUNT] [--output DIRECTORY]",
    );
    return;
  }
  const outputDirectory = args.output
    ? resolve(args.output)
    : join(root, "datasets", "fontclip-font-render-bank-v1");
  const artifacts = args.check
    ? verifyOutput(root, outputDirectory, args.limit)
    : await writeArtifacts(root, outputDirectory, args.limit);
  const manifest = artifacts.manifest;
  console.log(
    `${args.check ? "Verified" : "Wrote"} ${manifest.renders.length}/${manifest.generation.full_render_count} renderable (${manifest.generation.expected_render_count} expected) Chromium font renders at ${outputDirectory}`,
  );
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  MARKER_FILE,
  assertReplaceableOutput,
  parseArguments,
  readPngDimensions,
  verifyOutput,
  writeArtifacts,
};
