const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const {
  readCssFontFaces,
  readKoreanCatalog,
  toRepoPath,
} = require("./font-face-manifest/source-contract.cjs");
const { inspectSfnt } = require("./font-face-manifest/sfnt.cjs");

const SCHEMA_VERSION = "font-face-manifest-v1";
const REPORT_VERSION = "font-face-audit-report-v1";
const PRODUCTION_WEIGHTS = [400, 800];
const PRODUCTION_STYLES = ["normal", "italic"];
const DEDICATED_VERTICAL_FONT_ID = "seoul-namsan-vertical";
const REVIEW_PROBE =
  "가나다라마바사아자차카타파하 한글 폰트 읽기 쓰기 값 꽃 뷁 힣 0123 ABC xyz .,!?…·—“”‘’()[]{}";
const COVERAGE_BLOCKS = [
  { id: "hangul_jamo", start: 0x1100, end: 0x11ff },
  { id: "hangul_compatibility_jamo", start: 0x3130, end: 0x318f },
  { id: "hangul_jamo_extended_a", start: 0xa960, end: 0xa97f },
  { id: "hangul_syllables", start: 0xac00, end: 0xd7a3 },
  { id: "hangul_jamo_extended_b", start: 0xd7b0, end: 0xd7ff },
];

/** @typedef {{ tag: string; min: number; max: number }} VariationAxis */
/**
 * @typedef {{
 *   id: string;
 *   complete: boolean;
 * }} AuditedCoverageBlock
 */
/**
 * @typedef {{
 *   face_id: string;
 *   css: {
 *     weight: { raw: string; min: number; max: number };
 *     style: string;
 *     source_order: number;
 *   };
 *   internal: {
 *     variation_axes: VariationAxis[];
 *     os2: { weight_class: number | null };
 *   };
 *   style_binding: {
 *     intrinsic_italic: boolean;
 *     static_face_declared_as_weight_range: boolean;
 *   };
 *   coverage: { blocks: AuditedCoverageBlock[] };
 * }} AuditedFace
 */
/**
 * @typedef {{
 *   requested_weight: number;
 *   requested_style: string;
 *   synthetic_weight_or_static_alias: boolean;
 *   synthetic_italic: boolean;
 * }} StyleResolution
 */
/**
 * @typedef {{
 *   font_id: string;
 *   repository_license: { status: string };
 *   vertical_eligibility: { dedicated_vertical_face: boolean };
 *   production_style_resolution: StyleResolution[];
 *   faces: AuditedFace[];
 * }} AuditedFamily
 */
/**
 * @typedef {{
 *   schema_version: string;
 *   family_count: number;
 *   face_count: number;
 *   families: AuditedFamily[];
 * }} FontFaceManifest
 */

/**
 * @param {string} root
 */
function buildArtifacts(root) {
  const catalogPath = join(root, "src", "shared", "blockFontCatalog.ts");
  const cssPath = join(root, "src", "renderer", "src", "styles", "fonts.css");
  const rendererStylePath = join(
    root,
    "src",
    "renderer",
    "src",
    "components",
    "overlayTextStyles.ts",
  );
  const rendererComponentPath = join(
    root,
    "src",
    "renderer",
    "src",
    "components",
    "OverlayText.tsx",
  );
  const catalog = readKoreanCatalog(catalogPath);
  const cssFaces = readCssFontFaces(cssPath);
  const thirdParty = readThirdPartyKoreanFonts(root);

  const families = catalog.map((entry) => {
    const matchingFaces = cssFaces.filter(
      (face) => face.cssFamily === entry.cssFamily,
    );
    if (matchingFaces.length === 0) {
      throw new Error(`No CSS faces found for ${entry.fontId}.`);
    }
    return buildFamily(
      root,
      entry,
      matchingFaces,
      thirdParty.get(entry.fontId),
    );
  });
  const expectedFamilies = new Set(catalog.map((entry) => entry.cssFamily));
  const koreanAssetFaces = cssFaces.filter((face) =>
    toRepoPath(root, face.sourcePath).startsWith(
      "src/renderer/src/assets/fonts/",
    ),
  );
  const unexpected = koreanAssetFaces.filter(
    (face) =>
      !expectedFamilies.has(face.cssFamily) &&
      !/\/(?:en|ja|zh-hans|zh-hant)\//.test(toRepoPath(root, face.sourcePath)),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Uncatalogued Korean font faces: ${unexpected.map((face) => face.cssFamily).join(", ")}`,
    );
  }

  const inputs = [
    catalogPath,
    cssPath,
    rendererStylePath,
    rendererComponentPath,
  ].map((path) => ({
    path: toRepoPath(root, path),
    sha256: sha256(readFileSync(path)),
  }));
  const manifest = {
    schema_version: SCHEMA_VERSION,
    deterministic: true,
    inputs,
    production_renderer_contract: {
      requested_weights: PRODUCTION_WEIGHTS,
      requested_styles: PRODUCTION_STYLES,
      writing_modes: ["horizontal", "vertical"],
      render_bank_status: "contract-only",
      render_bank_axes: [
        "font_id",
        "face_id",
        "text_probe_id",
        "writing_mode",
        "font_size_px",
        "letter_spacing_px",
        "font_weight",
        "font_style",
        "outline",
        "shadow",
        "fill",
        "inverse",
      ],
      note: "P0 freezes source faces and style resolution. Raster render-bank images are intentionally not generated here.",
    },
    coverage_contract: {
      blocks: COVERAGE_BLOCKS.map((block) => ({
        ...block,
        range: `${formatCodePoint(block.start)}-${formatCodePoint(block.end)}`,
        total: block.end - block.start + 1,
      })),
      primary_gate: "hangul_syllables",
      review_probe: { id: "ko-review-probe-v1", text: REVIEW_PROBE },
    },
    family_count: families.length,
    face_count: families.reduce((sum, family) => sum + family.faces.length, 0),
    families,
  };
  if (manifest.family_count !== 22 || manifest.face_count !== 38) {
    throw new Error(
      `Expected 22 Korean families and 38 faces, found ${manifest.family_count}/${manifest.face_count}.`,
    );
  }
  const serializedManifest = serializeJson(manifest);
  const report = buildReport(manifest, sha256(Buffer.from(serializedManifest)));
  return {
    manifest,
    report,
    serializedManifest,
    serializedReport: serializeJson(report),
  };
}

/**
 * @param {string} root
 * @param {{ fontId: string; label: string; cssFamily: string }} entry
 * @param {Array<{ cssFamily: string; sourcePath: string; format: string; weight: { raw: string; min: number; max: number }; style: string; sourceOrder: number }>} cssFaces
 * @param {Record<string, unknown> | undefined} thirdPartyEntry
 */
function buildFamily(root, entry, cssFaces, thirdPartyEntry) {
  const faces = cssFaces.map((face, index) => {
    const bytes = readFileSync(face.sourcePath);
    const inspection = inspectSfnt(bytes);
    const fileSha = sha256(bytes);
    const faceId = `${entry.fontId}:${index + 1}:${fileSha.slice(0, 12)}`;
    const coverage = buildCoverage(inspection.unicode_ranges);
    const internalWeight = inspection.os2.weight_class;
    const weightAxis = inspection.variation_axes.find(
      (axis) => axis.tag === "wght",
    );
    return {
      face_id: faceId,
      file: toRepoPath(root, face.sourcePath),
      byte_size: bytes.length,
      sha256: fileSha,
      format: face.format,
      css: {
        family: face.cssFamily,
        weight: face.weight,
        style: face.style,
        source_order: face.sourceOrder,
      },
      internal: {
        sfnt_signature: inspection.sfnt_signature,
        names: inspection.names,
        units_per_em: inspection.units_per_em,
        glyph_count: inspection.glyph_count,
        os2: inspection.os2,
        head: inspection.head,
        post: inspection.post,
        variation_axes: inspection.variation_axes,
        unicode_range_count: inspection.unicode_ranges.length,
        vertical: inspection.vertical,
      },
      coverage,
      style_binding: {
        variable_weight: Boolean(weightAxis),
        static_face_declared_as_weight_range:
          !weightAxis && face.weight.min !== face.weight.max,
        css_weight_matches_internal:
          internalWeight !== null &&
          face.weight.min === face.weight.max &&
          face.weight.min === internalWeight,
        intrinsic_italic:
          inspection.os2.italic ||
          inspection.head.italic ||
          inspection.post.italic_angle !== 0,
      },
    };
  });
  const productionStyleResolution = PRODUCTION_STYLES.flatMap((style) =>
    PRODUCTION_WEIGHTS.map((weight) =>
      resolveStyleRequest(faces, weight, style),
    ),
  );
  const coverageFingerprints = new Set(
    faces.map((face) => JSON.stringify(face.coverage)),
  );
  const dedicatedVertical = entry.fontId === DEDICATED_VERTICAL_FONT_ID;
  return {
    font_id: entry.fontId,
    label: entry.label,
    locale: "ko",
    css_family: entry.cssFamily,
    vertical_eligibility: {
      allowed_writing_modes: dedicatedVertical
        ? ["vertical"]
        : ["horizontal", "vertical"],
      dedicated_vertical_face: dedicatedVertical,
      selection_rule: dedicatedVertical
        ? "render_direction_must_equal_vertical"
        : "no_font_specific_direction_restriction",
    },
    repository_license: readRepositoryLicense(
      root,
      entry.fontId,
      thirdPartyEntry,
    ),
    coverage_consistent_across_faces: coverageFingerprints.size === 1,
    production_style_resolution: productionStyleResolution,
    faces,
  };
}

/** @param {Array<{ start: number; end: number }>} ranges */
function buildCoverage(ranges) {
  const blocks = COVERAGE_BLOCKS.map((block) => {
    const supported = countCovered(ranges, block.start, block.end);
    const total = block.end - block.start + 1;
    return {
      id: block.id,
      supported,
      total,
      ratio: roundedRatio(supported, total),
      complete: supported === total,
    };
  });
  const probeCodePoints = [
    ...new Set([...REVIEW_PROBE].map((value) => value.codePointAt(0))),
  ].filter((value) => value !== undefined);
  const missing = probeCodePoints.filter(
    (codePoint) =>
      !ranges.some(
        (range) => codePoint >= range.start && codePoint <= range.end,
      ),
  );
  return {
    blocks,
    review_probe: {
      id: "ko-review-probe-v1",
      unique_codepoints: probeCodePoints.length,
      supported: probeCodePoints.length - missing.length,
      complete: missing.length === 0,
      missing_codepoints: missing.map(formatCodePoint),
    },
  };
}

/**
 * @param {AuditedFace[]} faces
 * @param {number} requestedWeight
 * @param {string} requestedStyle
 */
function resolveStyleRequest(faces, requestedWeight, requestedStyle) {
  const sameStyle = faces.filter((face) => face.css.style === requestedStyle);
  const candidates = sameStyle.length > 0 ? sameStyle : faces;
  const selected = [...candidates].sort((left, right) => {
    const leftDistance = weightDistance(left.css.weight, requestedWeight);
    const rightDistance = weightDistance(right.css.weight, requestedWeight);
    return (
      leftDistance - rightDistance ||
      left.css.weight.max -
        left.css.weight.min -
        (right.css.weight.max - right.css.weight.min) ||
      left.css.source_order - right.css.source_order
    );
  })[0];
  if (!selected) throw new Error("Cannot resolve an empty CSS font family.");
  const weightAxis = selected.internal.variation_axes.find(
    (axis) => axis.tag === "wght",
  );
  const intrinsicWeightMatch = weightAxis
    ? requestedWeight >= weightAxis.min && requestedWeight <= weightAxis.max
    : selected.internal.os2.weight_class === requestedWeight;
  const intrinsicItalic = selected.style_binding.intrinsic_italic;
  const syntheticItalic =
    requestedStyle === "italic" && selected.css.style !== "italic";
  const syntheticWeightOrStaticAlias = !intrinsicWeightMatch;
  return {
    requested_weight: requestedWeight,
    requested_style: requestedStyle,
    selected_face_id: selected.face_id,
    css_weight_match:
      requestedWeight >= selected.css.weight.min &&
      requestedWeight <= selected.css.weight.max,
    css_style_match: selected.css.style === requestedStyle,
    intrinsic_weight_match: intrinsicWeightMatch,
    intrinsic_italic_match:
      requestedStyle === "normal" ? !intrinsicItalic : intrinsicItalic,
    synthetic_weight_or_static_alias: syntheticWeightOrStaticAlias,
    synthetic_italic: syntheticItalic,
    synthetic_style: syntheticWeightOrStaticAlias || syntheticItalic,
  };
}

/** @param {{ min: number; max: number }} range @param {number} weight */
function weightDistance(range, weight) {
  if (weight < range.min) return range.min - weight;
  if (weight > range.max) return weight - range.max;
  return 0;
}

/**
 * @param {Array<{ start: number; end: number }>} ranges
 * @param {number} start @param {number} end
 */
function countCovered(ranges, start, end) {
  return ranges.reduce((sum, range) => {
    const overlapStart = Math.max(start, range.start);
    const overlapEnd = Math.min(end, range.end);
    return sum + Math.max(0, overlapEnd - overlapStart + 1);
  }, 0);
}

/** @param {number} numerator @param {number} denominator */
function roundedRatio(numerator, denominator) {
  return Number((numerator / denominator).toFixed(6));
}

/** @param {number} codePoint */
function formatCodePoint(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** @param {string} root */
function readThirdPartyKoreanFonts(root) {
  const path = join(root, "third_party", "fonts", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const entries = /** @type {Array<Record<string, unknown>>} */ (
    Array.isArray(manifest.koreanFonts) ? manifest.koreanFonts : []
  );
  return new Map(entries.map((entry) => [String(entry.id), entry]));
}

/**
 * @param {string} root @param {string} fontId
 * @param {Record<string, unknown> | undefined} manifestEntry
 */
function readRepositoryLicense(root, fontId, manifestEntry) {
  const directory = join(root, "third_party", "fonts", fontId);
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => /^(?:OFL|LICENSE|NOTICE).*\.(?:txt|pdf)$/i.test(file))
        .sort()
        .map((file) => {
          const path = join(directory, file);
          return {
            path: toRepoPath(root, path),
            sha256: sha256(readFileSync(path)),
          };
        })
    : [];
  return {
    status: files.length > 0 ? "recorded" : "not-recorded-in-third-party-fonts",
    declared_license:
      typeof manifestEntry?.license === "string" ? manifestEntry.license : null,
    source:
      typeof manifestEntry?.source === "string" ? manifestEntry.source : null,
    files,
  };
}

/** @param {FontFaceManifest} manifest @param {string} manifestSha */
function buildReport(manifest, manifestSha) {
  const allFaces = manifest.families.flatMap((family) =>
    family.faces.map((face) => ({ family, face })),
  );
  const limitedSyllableFaces = allFaces
    .filter(({ face }) =>
      face.coverage.blocks.some(
        (block) => block.id === "hangul_syllables" && !block.complete,
      ),
    )
    .map(({ family, face }) => ({
      font_id: family.font_id,
      face_id: face.face_id,
    }));
  const staticRangeFaces = allFaces
    .filter(
      ({ face }) => face.style_binding.static_face_declared_as_weight_range,
    )
    .map(({ family, face }) => ({
      font_id: family.font_id,
      face_id: face.face_id,
    }));
  const syntheticBoldFamilies = manifest.families
    .filter((family) =>
      family.production_style_resolution.some(
        (request) =>
          request.requested_weight === 800 &&
          request.requested_style === "normal" &&
          request.synthetic_weight_or_static_alias,
      ),
    )
    .map((family) => family.font_id);
  const missingLicenseFamilies = manifest.families
    .filter((family) => family.repository_license.status !== "recorded")
    .map((family) => family.font_id);
  return {
    schema_version: REPORT_VERSION,
    manifest_schema_version: manifest.schema_version,
    manifest_sha256: manifestSha,
    summary: {
      family_count: manifest.family_count,
      face_count: manifest.face_count,
      full_hangul_syllable_face_count:
        allFaces.length - limitedSyllableFaces.length,
      limited_hangul_syllable_face_count: limitedSyllableFaces.length,
      static_face_weight_range_count: staticRangeFaces.length,
      intrinsic_800_family_count:
        manifest.family_count - syntheticBoldFamilies.length,
      synthetic_or_aliased_800_family_count: syntheticBoldFamilies.length,
      intrinsic_italic_family_count: manifest.families.filter((family) =>
        family.production_style_resolution.some(
          (request) =>
            request.requested_style === "italic" && !request.synthetic_italic,
        ),
      ).length,
      dedicated_vertical_family_count: manifest.families.filter(
        (family) => family.vertical_eligibility.dedicated_vertical_face,
      ).length,
      repository_license_recorded_family_count:
        manifest.family_count - missingLicenseFamilies.length,
    },
    cohorts: {
      limited_hangul_syllable_faces: limitedSyllableFaces,
      static_faces_declared_as_weight_ranges: staticRangeFaces,
      synthetic_or_aliased_800_families: syntheticBoldFamilies,
      repository_license_not_recorded: missingLicenseFamilies,
    },
    findings: [
      {
        code: "CSS_WEIGHT_IS_NOT_INTRINSIC_WEIGHT",
        severity: "warning",
        count: syntheticBoldFamilies.length,
        detail:
          "A production 800 request does not map to an intrinsic 800 outline for these families; render-bank labels must preserve this distinction.",
      },
      {
        code: "ITALIC_IS_SYNTHETIC",
        severity: "warning",
        count: manifest.family_count,
        detail:
          "The Korean CSS catalog declares no italic face. Italic render-bank variants must be labeled synthetic.",
      },
      {
        code: "HANGUL_SYLLABLE_COVERAGE_LIMITED",
        severity: "warning",
        count: limitedSyllableFaces.length,
        detail:
          "These faces do not cover all 11,172 precomposed Hangul syllables and require string-level coverage checks.",
      },
      {
        code: "REPOSITORY_LICENSE_RECORD_MISSING",
        severity: "audit",
        count: missingLicenseFamilies.length,
        detail:
          "The font is bundled, but this repository has no matching record under third_party/fonts/<font_id>.",
      },
    ],
  };
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {unknown} value */
function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** @param {string} root @param {string} outputDirectory */
function writeArtifacts(root, outputDirectory) {
  const artifacts = buildArtifacts(root);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(outputDirectory, "manifest.json"),
    artifacts.serializedManifest,
  );
  writeFileSync(
    join(outputDirectory, "report.json"),
    artifacts.serializedReport,
  );
  return artifacts;
}

/** @param {string} root @param {string} outputDirectory */
function checkArtifacts(root, outputDirectory) {
  const artifacts = buildArtifacts(root);
  const expected = [
    ["manifest.json", artifacts.serializedManifest],
    ["report.json", artifacts.serializedReport],
  ];
  const stale = expected.filter(([name, content]) => {
    const path = join(outputDirectory, name);
    return !existsSync(path) || readFileSync(path, "utf8") !== content;
  });
  if (stale.length > 0) {
    throw new Error(
      `Font face contract is missing or stale: ${stale.map(([name]) => name).join(", ")}. Run npm run build:font-face-manifest.`,
    );
  }
  return artifacts;
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let check = false;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") check = true;
    else if (argument === "--output") {
      output = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--help") {
      return { help: true, check, output };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { help: false, check, output };
}

function main() {
  const root = resolve(__dirname, "..");
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/build-font-face-manifest.cjs [--check] [--output DIRECTORY]",
    );
    return;
  }
  const outputDirectory = args.output
    ? resolve(args.output)
    : join(root, "datasets", "fontclip-font-catalog-v2");
  const artifacts = args.check
    ? checkArtifacts(root, outputDirectory)
    : writeArtifacts(root, outputDirectory);
  console.log(
    `${args.check ? "Verified" : "Wrote"} ${artifacts.manifest.family_count} Korean font families / ${artifacts.manifest.face_count} faces at ${outputDirectory}`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildArtifacts,
  checkArtifacts,
  writeArtifacts,
};
