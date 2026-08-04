import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCustomFontBuffer } from "../src/main/customFontInspection";
import { BUILT_IN_BLOCK_FONTS } from "../src/shared/blockFontCatalog";

type CoverageBlock = {
  id: string;
  supported: number;
  total: number;
  ratio: number;
  complete: boolean;
};

type FontFaceManifest = {
  schema_version: string;
  deterministic: boolean;
  family_count: number;
  face_count: number;
  families: Array<{
    font_id: string;
    vertical_eligibility: {
      allowed_writing_modes: string[];
      dedicated_vertical_face: boolean;
    };
    production_style_resolution: Array<{
      requested_weight: number;
      requested_style: string;
      selected_face_id: string;
      synthetic_italic: boolean;
    }>;
    faces: Array<{
      face_id: string;
      file: string;
      sha256: string;
      css: { weight: { raw: string; min: number; max: number } };
      internal: {
        names: { full_name: string | null };
        os2: { weight_class: number | null };
        unicode_range_count: number;
      };
      coverage: {
        blocks: CoverageBlock[];
        review_probe: {
          unique_codepoints: number;
          supported: number;
          missing_codepoints: string[];
        };
      };
    }>;
  }>;
};

type FontFaceReport = {
  schema_version: string;
  manifest_sha256: string;
  summary: {
    family_count: number;
    face_count: number;
    limited_hangul_syllable_face_count: number;
    static_face_weight_range_count: number;
    synthetic_or_aliased_800_family_count: number;
  };
};

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "build-font-face-manifest.cjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("font-face-manifest-v1", () => {
  it("deterministically audits all 21 Korean families and 37 production faces", () => {
    const output = mkdtempSync(join(tmpdir(), "mgt-font-face-manifest-"));
    temporaryDirectories.push(output);

    runGenerator(output);
    const manifestBytes = readFileSync(join(output, "manifest.json"));
    const reportBytes = readFileSync(join(output, "report.json"));
    const manifest = JSON.parse(
      manifestBytes.toString("utf8"),
    ) as FontFaceManifest;
    const report = JSON.parse(reportBytes.toString("utf8")) as FontFaceReport;

    const koreanCatalogIds = BUILT_IN_BLOCK_FONTS.filter(
      (font) => font.locale === "ko",
    ).map((font) => font.id);
    expect(manifest.schema_version).toBe("font-face-manifest-v1");
    expect(manifest.deterministic).toBe(true);
    expect(manifest.family_count).toBe(21);
    expect(manifest.face_count).toBe(37);
    expect(manifest.families.map((family) => family.font_id)).toEqual(
      koreanCatalogIds,
    );
    expect(report.schema_version).toBe("font-face-audit-report-v1");
    expect(report.manifest_sha256).toBe(sha256(manifestBytes));
    expect(report.summary).toMatchObject({
      family_count: 21,
      face_count: 37,
      limited_hangul_syllable_face_count: 8,
      static_face_weight_range_count: 4,
      synthetic_or_aliased_800_family_count: 21,
    });

    assertFaceContracts(manifest);
    assertVerticalAndStyleContracts(manifest);

    execFileSync(process.execPath, [SCRIPT, "--check", "--output", output], {
      cwd: ROOT,
      stdio: "pipe",
    });
    expect(readFileSync(join(output, "manifest.json"))).toEqual(manifestBytes);
    expect(readFileSync(join(output, "report.json"))).toEqual(reportBytes);
  });
});

function assertFaceContracts(manifest: FontFaceManifest) {
  const faceIds = new Set<string>();
  for (const family of manifest.families) {
    expect(family.faces.length).toBeGreaterThan(0);
    for (const face of family.faces) {
      expect(faceIds.has(face.face_id), face.face_id).toBe(false);
      faceIds.add(face.face_id);
      const bytes = readFileSync(join(ROOT, ...face.file.split("/")));
      const productionInspection = inspectCustomFontBuffer(bytes);
      expect(face.sha256).toBe(sha256(bytes));
      expect(face.css.weight.min).toBeLessThanOrEqual(face.css.weight.max);
      expect(face.internal.names.full_name).toBeTruthy();
      expect(face.internal.unicode_range_count).toBeGreaterThan(0);
      expect(face.coverage.blocks.map((block) => block.id)).toEqual([
        "hangul_jamo",
        "hangul_compatibility_jamo",
        "hangul_jamo_extended_a",
        "hangul_syllables",
        "hangul_jamo_extended_b",
      ]);
      for (const block of face.coverage.blocks) {
        const contractBlock = COVERAGE_RANGES[block.id];
        expect(contractBlock).toBeDefined();
        expect(block.supported).toBeLessThanOrEqual(block.total);
        expect(block.ratio).toBeCloseTo(block.supported / block.total, 6);
        expect(block.complete).toBe(block.supported === block.total);
        expect(block.supported).toBe(
          countRangeCoverage(
            productionInspection.unicodeRanges,
            contractBlock?.start ?? 0,
            contractBlock?.end ?? 0,
          ),
        );
      }
      expect(face.internal.os2.weight_class).toBe(productionInspection.weight);
      expect(face.coverage.review_probe.supported).toBe(
        face.coverage.review_probe.unique_codepoints -
          face.coverage.review_probe.missing_codepoints.length,
      );
    }
  }
  expect(faceIds.size).toBe(37);
}

const COVERAGE_RANGES: Record<string, { start: number; end: number }> = {
  hangul_jamo: { start: 0x1100, end: 0x11ff },
  hangul_compatibility_jamo: { start: 0x3130, end: 0x318f },
  hangul_jamo_extended_a: { start: 0xa960, end: 0xa97f },
  hangul_syllables: { start: 0xac00, end: 0xd7a3 },
  hangul_jamo_extended_b: { start: 0xd7b0, end: 0xd7ff },
};

function countRangeCoverage(
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
) {
  return ranges.reduce((sum, range) => {
    const overlapStart = Math.max(start, range[0]);
    const overlapEnd = Math.min(end, range[1]);
    return sum + Math.max(0, overlapEnd - overlapStart + 1);
  }, 0);
}

function assertVerticalAndStyleContracts(manifest: FontFaceManifest) {
  const dedicatedVertical = manifest.families.filter(
    (family) => family.vertical_eligibility.dedicated_vertical_face,
  );
  expect(dedicatedVertical.map((family) => family.font_id)).toEqual([
    "seoul-namsan-vertical",
  ]);
  expect(
    dedicatedVertical[0]?.vertical_eligibility.allowed_writing_modes,
  ).toEqual(["vertical"]);

  for (const family of manifest.families) {
    expect(family.production_style_resolution).toHaveLength(4);
    const faceIds = new Set(family.faces.map((face) => face.face_id));
    for (const request of family.production_style_resolution) {
      expect(faceIds.has(request.selected_face_id)).toBe(true);
      if (request.requested_style === "italic") {
        expect(request.synthetic_italic).toBe(true);
      }
      expect([400, 800]).toContain(request.requested_weight);
    }
  }
}

function runGenerator(output: string) {
  execFileSync(process.execPath, [SCRIPT, "--output", output], {
    cwd: ROOT,
    stdio: "pipe",
  });
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
