const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { buildArtifacts } = require("../build-font-face-manifest.cjs");
const { inspectSfnt } = require("../font-face-manifest/sfnt.cjs");

const SCHEMA_VERSION = "font-render-bank-v1";
const REPORT_VERSION = "font-render-bank-report-v1";
const OWNER = "carrot-manga-translator/font-render-bank";

const PROBES = [
  {
    id: "dialogue-body",
    role: "dialogue_body",
    text: "지금 가는 거야?",
    font_size_px: 44,
    vertical_font_size_px: 32,
    letter_spacing_em: 0,
  },
  {
    id: "narration",
    role: "narration",
    text: "그날 밤의 기록.",
    font_size_px: 40,
    vertical_font_size_px: 32,
    letter_spacing_em: 0.02,
  },
  {
    id: "thought-monologue",
    role: "thought_monologue",
    text: "설마, 기다릴까?",
    font_size_px: 42,
    vertical_font_size_px: 32,
    letter_spacing_em: 0.01,
  },
  {
    id: "aside-whisper",
    role: "aside_whisper",
    text: "저기, 잠깐만.",
    font_size_px: 36,
    vertical_font_size_px: 32,
    letter_spacing_em: 0.04,
  },
  {
    id: "emphasis-shout",
    role: "emphasis_shout",
    text: "포기 안 해!",
    font_size_px: 52,
    vertical_font_size_px: 40,
    letter_spacing_em: 0.02,
  },
  {
    id: "sfx-impact",
    role: "sfx_impact",
    text: "쾅!!",
    font_size_px: 64,
    vertical_font_size_px: 64,
    letter_spacing_em: -0.03,
  },
  {
    id: "sfx-motion",
    role: "sfx_motion",
    text: "휘익-",
    font_size_px: 58,
    vertical_font_size_px: 58,
    letter_spacing_em: 0.04,
  },
  {
    id: "sfx-ambient",
    role: "sfx_ambient",
    text: "스산...",
    font_size_px: 48,
    vertical_font_size_px: 48,
    letter_spacing_em: 0.08,
  },
  {
    id: "sfx-emotion",
    role: "sfx_emotion",
    text: "두근 두근",
    font_size_px: 48,
    vertical_font_size_px: 48,
    letter_spacing_em: 0.03,
  },
  {
    id: "sfx-comic-reaction",
    role: "sfx_comic_reaction",
    text: "삐질...",
    font_size_px: 54,
    vertical_font_size_px: 54,
    letter_spacing_em: 0,
  },
];

const RENDER_SPEC = {
  background: "#ffffff",
  fill: "#111111",
  horizontal_canvas: { width: 448, height: 224 },
  vertical_canvas: { width: 224, height: 480 },
  padding_px: 24,
  line_height: 1.15,
  font_synthesis: "weight style",
  font_kerning: "normal",
  text_rendering: "geometricPrecision",
  device_scale_factor: 1,
  capture_format: "png",
  qa_overlay: false,
};

/**
 * @typedef {{
 *   display_id: string;
 *   blind_alias: string;
 *   browser_family_alias: string;
 *   font_id: string;
 *   font_label: string;
 *   css_family: string;
 *   face_id: string;
 *   source_file: string;
 *   source_sha256: string;
 *   format: string;
 *   source_css_weight: {raw: string; min: number; max: number};
 *   source_css_style: string;
 *   render_weight: number;
 *   render_style: string;
 *   allowed_writing_modes: string[];
 *   probe_coverage_complete: boolean;
 *   missing_probe_codepoints: string[];
 *   production_asset_status: {
 *     chromium_ots_compatible: boolean;
 *     code: string;
 *     zero_length_tables: string[];
 *     evidence: string | null;
 *   };
 *   production_request_bindings: Array<{
 *     requested_weight: number;
 *     requested_style: string;
 *     synthetic_style: boolean;
 *   }>;
 *   production_400_normal_canonical: boolean;
 * }} RenderCandidate
 */

/**
 * @typedef {{
 *   render_id: string;
 *   candidate_display_id: string;
 *   blind_alias: string;
 *   browser_family_alias: string;
 *   source_file: string;
 *   source_format: string;
 *   production_css_family: string;
 *   font_weight: number;
 *   font_style: string;
 *   probe_id: string;
 *   role: string;
 *   text: string;
 *   writing_mode: string;
 *   font_size_px: number;
 *   letter_spacing_em: number;
 *   letter_spacing_px: number;
 *   canvas: {width: number; height: number};
 *   image_file: string;
 * }} RenderJob
 */

/**
 * @param {string} root
 * @param {{limit?: number | null}} [options]
 */
function buildRenderPlan(root, options = {}) {
  const faceArtifacts = buildArtifacts(root);
  const sourceManifestSha256 = sha256(
    Buffer.from(faceArtifacts.serializedManifest),
  );
  const candidates = buildCandidates(root, faceArtifacts.manifest.families);
  const expectedJobs = candidates.flatMap(buildCandidateJobs);
  const allJobs = candidates
    .filter(
      (candidate) => candidate.production_asset_status.chromium_ots_compatible,
    )
    .flatMap(buildCandidateJobs);
  const limit = options.limit ?? null;
  const jobs = limit === null ? allJobs : allJobs.slice(0, limit);
  if (limit !== null && jobs.length !== limit) {
    throw new Error(
      `--limit ${limit} exceeds the renderable count ${allJobs.length}.`,
    );
  }
  const specification = {
    schema_version: SCHEMA_VERSION,
    source_face_manifest_sha256: sourceManifestSha256,
    render_spec: RENDER_SPEC,
    probes: PROBES,
    candidates,
    expected_render_count: expectedJobs.length,
    full_render_count: allJobs.length,
    limit,
    renders: jobs.map(publicJobSpec),
  };
  return {
    schema_version: SCHEMA_VERSION,
    source_face_manifest_sha256: sourceManifestSha256,
    source_face_manifest: faceArtifacts.manifest,
    render_spec: RENDER_SPEC,
    probes: PROBES,
    candidates,
    expected_render_count: expectedJobs.length,
    full_render_count: allJobs.length,
    jobs,
    limit,
    specification_sha256: sha256(Buffer.from(stableJson(specification))),
  };
}

/** @param {string} root @param {Array<Record<string, unknown>>} families */
function buildCandidates(root, families) {
  /** @type {RenderCandidate[]} */
  const candidates = [];
  for (const familyValue of families) {
    const family = /** @type {Record<string, any>} */ (familyValue);
    for (const face of family.faces) {
      const sourcePath = join(root, ...String(face.file).split("/"));
      const sourceBytes = readFileSync(sourcePath);
      const ranges = inspectSfnt(sourceBytes).unicode_ranges;
      const zeroLengthTables = findZeroLengthSfntTables(sourceBytes);
      const missing = findMissingProbeCodepoints(ranges);
      if (missing.length > 0) {
        throw new Error(
          `${family.font_id}/${face.face_id} cannot render probe codepoints: ${missing.join(", ")}.`,
        );
      }
      for (const renderWeight of resolveRenderWeights(face.css.weight)) {
        /** @type {Array<{requested_weight: number; requested_style: string; synthetic_style: boolean}>} */
        const requestBindings = family.production_style_resolution
          .filter(
            (/** @type {Record<string, any>} */ request) =>
              request.selected_face_id === face.face_id &&
              request.requested_weight === renderWeight &&
              request.requested_style === face.css.style,
          )
          .map((/** @type {Record<string, any>} */ request) => ({
            requested_weight: request.requested_weight,
            requested_style: request.requested_style,
            synthetic_style: request.synthetic_style,
          }));
        const displayId = [
          family.font_id,
          face.face_id,
          `w${renderWeight}`,
          face.css.style,
        ].join("/");
        const fingerprint = sha256(
          Buffer.from(`${SCHEMA_VERSION}:${displayId}`),
        );
        candidates.push({
          display_id: displayId,
          blind_alias: `ko-candidate-${fingerprint.slice(0, 16)}`,
          browser_family_alias: `MGT Render Bank ${fingerprint.slice(0, 24)}`,
          font_id: family.font_id,
          font_label: family.label,
          css_family: family.css_family,
          face_id: face.face_id,
          source_file: face.file,
          source_sha256: face.sha256,
          format: face.format,
          source_css_weight: face.css.weight,
          source_css_style: face.css.style,
          render_weight: renderWeight,
          render_style: face.css.style,
          allowed_writing_modes:
            family.vertical_eligibility.allowed_writing_modes,
          probe_coverage_complete: true,
          missing_probe_codepoints: [],
          production_asset_status: {
            chromium_ots_compatible: zeroLengthTables.length === 0,
            code:
              zeroLengthTables.length === 0
                ? "passed"
                : "chromium-ots-zero-length-table",
            zero_length_tables: zeroLengthTables,
            evidence:
              zeroLengthTables.length === 0
                ? null
                : `Chromium OTS rejects ${face.file}: ${zeroLengthTables.join(", ")}: zero-length table`,
          },
          production_request_bindings: requestBindings,
          production_400_normal_canonical: requestBindings.some(
            (binding) =>
              binding.requested_weight === 400 &&
              binding.requested_style === "normal",
          ),
        });
      }
    }
  }
  assertUnique(
    candidates.map((candidate) => candidate.display_id),
    "display ID",
  );
  assertUnique(
    candidates.map((candidate) => candidate.blind_alias),
    "blind alias",
  );
  return candidates;
}

/** @param {{min: number; max: number}} weight */
function resolveRenderWeights(weight) {
  return weight.min === weight.max ? [weight.min] : [weight.min, weight.max];
}

/** @param {Buffer} bytes */
function findZeroLengthSfntTables(bytes) {
  if (bytes.length < 12) throw new Error("Font SFNT header is truncated.");
  const tableCount = bytes.readUInt16BE(4);
  if (bytes.length < 12 + tableCount * 16) {
    throw new Error("Font SFNT table directory is truncated.");
  }
  const empty = [];
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (bytes.readUInt32BE(record + 12) === 0) {
      empty.push(bytes.toString("latin1", record, record + 4));
    }
  }
  return empty;
}

/** @param {Array<{start: number; end: number}>} ranges */
function findMissingProbeCodepoints(ranges) {
  const codepoints = new Set(
    PROBES.flatMap((probe) =>
      [...probe.text]
        .filter((character) => !/\s/u.test(character))
        .map((character) => character.codePointAt(0)),
    ).filter((value) => value !== undefined),
  );
  return [...codepoints]
    .filter(
      (codepoint) =>
        !ranges.some(
          (range) => codepoint >= range.start && codepoint <= range.end,
        ),
    )
    .sort((left, right) => left - right)
    .map(formatCodepoint);
}

/** @param {RenderCandidate} candidate */
function buildCandidateJobs(candidate) {
  /** @type {RenderJob[]} */
  const jobs = [];
  for (const probe of PROBES) {
    for (const writingMode of candidate.allowed_writing_modes) {
      const shortMode = writingMode === "vertical" ? "v" : "h";
      const fontSize =
        writingMode === "vertical"
          ? probe.vertical_font_size_px
          : probe.font_size_px;
      const identity = `${candidate.display_id}/${probe.id}/${writingMode}`;
      jobs.push({
        render_id: `render-${sha256(Buffer.from(identity)).slice(0, 20)}`,
        candidate_display_id: candidate.display_id,
        blind_alias: candidate.blind_alias,
        browser_family_alias: candidate.browser_family_alias,
        source_file: candidate.source_file,
        source_format: candidate.format,
        production_css_family: candidate.css_family,
        font_weight: candidate.render_weight,
        font_style: candidate.render_style,
        probe_id: probe.id,
        role: probe.role,
        text: probe.text,
        writing_mode: writingMode,
        font_size_px: fontSize,
        letter_spacing_em: probe.letter_spacing_em,
        letter_spacing_px: Number(
          (fontSize * probe.letter_spacing_em).toFixed(4),
        ),
        canvas:
          writingMode === "vertical"
            ? RENDER_SPEC.vertical_canvas
            : RENDER_SPEC.horizontal_canvas,
        image_file: `images/${candidate.blind_alias}/${probe.id}-${shortMode}.png`,
      });
    }
  }
  return jobs;
}

/** @param {RenderJob} job */
function publicJobSpec(job) {
  const { browser_family_alias: _browserAlias, ...publicJob } = job;
  return publicJob;
}

/** @param {number} codepoint */
function formatCodepoint(codepoint) {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** @param {string[]} values @param {string} label */
function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`Font render-bank ${label} values must be unique.`);
  }
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {unknown} value */
function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

/** @param {unknown} value */
function serializeJson(value) {
  return `${stableJson(value)}\n`;
}

module.exports = {
  OWNER,
  PROBES,
  REPORT_VERSION,
  RENDER_SPEC,
  SCHEMA_VERSION,
  buildRenderPlan,
  publicJobSpec,
  serializeJson,
  sha256,
  stableJson,
};
