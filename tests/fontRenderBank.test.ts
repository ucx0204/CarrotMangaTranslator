import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type RenderPlan = {
  candidates: Array<{
    display_id: string;
    blind_alias: string;
    face_id: string;
    font_id: string;
    render_weight: number;
    allowed_writing_modes: string[];
    source_sha256: string;
    production_asset_status: {
      chromium_ots_compatible: boolean;
      zero_length_tables: string[];
    };
    production_400_normal_canonical: boolean;
  }>;
  jobs: Array<{
    render_id: string;
    writing_mode: string;
    image_file: string;
  }>;
  probes: Array<{
    id: string;
    role: string;
    font_size_px: number;
    vertical_font_size_px: number;
    letter_spacing_em: number;
  }>;
  full_render_count: number;
  expected_render_count: number;
  source_face_manifest: { family_count: number; face_count: number };
};

type RenderManifest = {
  schema_version: string;
  specification_sha256: string;
  family_count: number;
  face_count: number;
  candidate_count: number;
  rendered_candidate_count: number;
  generation: {
    limit: number | null;
    partial: boolean;
    full_render_count: number;
    expected_render_count: number;
    production_asset_omitted_render_count: number;
    complete_against_production_assets: boolean;
    rendered_count: number;
  };
  renderer: {
    engine: string;
    production_stylesheet: string;
    production_stylesheet_loaded_via: string;
  };
  render_spec: {
    qa_overlay: boolean;
    padding_px: number;
    horizontal_canvas: { width: number; height: number };
    vertical_canvas: { width: number; height: number };
  };
  candidate_identity_contract: {
    display_id_field: string;
    blind_alias_field: string;
    image_paths_expose_font_identity: boolean;
  };
  candidates: Array<{
    display_id: string;
    blind_alias: string;
    font_id: string;
    face_id: string;
    source_sha256: string;
    production_asset_status: {
      chromium_ots_compatible: boolean;
      zero_length_tables: string[];
    };
  }>;
  renders: Array<{
    render_id: string;
    candidate_display_id: string;
    blind_alias: string;
    writing_mode: string;
    readiness: {
      document_fonts_ready: boolean;
      font_check_passed: boolean;
      production_font_check_passed: boolean;
      content_fits: boolean;
    };
    fallback_detection: { status: string; metric_max_delta: number };
    pixels: {
      ink_pixel_count: number;
      ink_bounds: {
        min_x: number;
        min_y: number;
        max_x: number;
        max_y: number;
      };
      qa_overlay: boolean;
    };
    artifact: {
      file: string;
      sha256: string;
      byte_size: number;
      width: number;
      height: number;
      qa_overlay: boolean;
    };
  }>;
};

type RenderReport = {
  schema_version: string;
  manifest_sha256: string;
  summary: {
    rendered_png_count: number;
    fonts_ready_pass_count: number;
    fallback_detection_pass_count: number;
    qa_overlay_png_count: number;
  };
};

type OwnershipMarker = {
  owner: string;
  manifest_sha256: string;
  report_sha256: string;
};

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "build-font-render-bank.cjs");
const { buildRenderPlan } = require("../scripts/font-render-bank/spec.cjs") as {
  buildRenderPlan: (root: string, options?: { limit?: number }) => RenderPlan;
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    ),
  );
});

describe("font-render-bank-v1", () => {
  it("freezes 21 Korean families, all 37 physical faces, CSS weights, modes, and role probes", () => {
    const plan = buildRenderPlan(ROOT);

    expect(plan.source_face_manifest).toMatchObject({
      family_count: 21,
      face_count: 37,
    });
    expect(
      new Set(plan.candidates.map((candidate) => candidate.font_id)).size,
    ).toBe(21);
    expect(
      new Set(plan.candidates.map((candidate) => candidate.face_id)).size,
    ).toBe(37);
    expect(plan.candidates).toHaveLength(41);
    expect(plan.probes).toHaveLength(10);
    expect(plan.probes.map((probe) => probe.role)).toEqual([
      "dialogue_body",
      "narration",
      "thought_monologue",
      "aside_whisper",
      "emphasis_shout",
      "sfx_impact",
      "sfx_motion",
      "sfx_ambient",
      "sfx_emotion",
      "sfx_comic_reaction",
    ]);
    expect(
      plan.probes.every(
        (probe) =>
          probe.font_size_px > 0 &&
          probe.vertical_font_size_px > 0 &&
          Number.isFinite(probe.letter_spacing_em),
      ),
    ).toBe(true);
    expect(plan.jobs).toHaveLength(800);
    expect(plan.full_render_count).toBe(800);
    expect(plan.expected_render_count).toBe(800);
    expect(
      plan.jobs.filter((job) => job.writing_mode === "horizontal"),
    ).toHaveLength(390);
    expect(
      plan.jobs.filter((job) => job.writing_mode === "vertical"),
    ).toHaveLength(410);

    const unrenderable = plan.candidates.filter(
      (candidate) => !candidate.production_asset_status.chromium_ots_compatible,
    );
    expect(unrenderable).toEqual([]);
    const canonical = plan.candidates.filter(
      (candidate) => candidate.production_400_normal_canonical,
    );
    expect(canonical).toHaveLength(21);
    expect(
      canonical.every(
        (candidate) =>
          candidate.production_asset_status.chromium_ots_compatible,
      ),
    ).toBe(true);

    assertBlindIdentityContract(plan);
  });

  const electronFixture = process.platform === "win32" ? it : it.skip;
  electronFixture(
    "renders and checks clean horizontal/vertical PNG fixtures in production Chromium",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "mgt-font-render-bank-"));
      temporaryDirectories.push(parent);
      const output = join(parent, "owned-bank");

      expect(runGenerator(output, ["--limit", "2"]).status).toBe(0);
      const manifestBytes = readFileSync(join(output, "manifest.json"));
      const reportBytes = readFileSync(join(output, "report.json"));
      const manifest = JSON.parse(
        manifestBytes.toString("utf8"),
      ) as RenderManifest;
      const report = JSON.parse(reportBytes.toString("utf8")) as RenderReport;
      const marker = JSON.parse(
        readFileSync(join(output, ".font-render-bank-owned.json"), "utf8"),
      ) as OwnershipMarker;

      assertFixtureMetadata(
        manifest,
        report,
        marker,
        manifestBytes,
        reportBytes,
      );
      assertFixturePngs(output, manifest);
      expect(runGenerator(output, ["--check", "--limit", "2"]).status).toBe(0);

      const firstRender = manifest.renders[0];
      if (!firstRender) throw new Error("Fixture render is missing.");
      const firstPng = join(output, ...firstRender.artifact.file.split("/"));
      appendFileSync(firstPng, Buffer.from("tamper"));
      const tampered = runGenerator(output, ["--check", "--limit", "2"]);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain("artifact check failed");

      const unowned = join(parent, "unowned-bank");
      mkdirSync(unowned);
      writeFileSync(join(unowned, "keep.txt"), "user data", "utf8");
      const refused = runGenerator(unowned, ["--limit", "1"]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("unowned");
      expect(readFileSync(join(unowned, "keep.txt"), "utf8")).toBe("user data");
    },
    60_000,
  );
});

function assertBlindIdentityContract(plan: RenderPlan) {
  expect(
    plan.candidates.every(
      (candidate) =>
        /^ko-candidate-[0-9a-f]{16}$/.test(candidate.blind_alias) &&
        candidate.blind_alias !== candidate.display_id,
    ),
  ).toBe(true);
  expect(
    new Set(plan.candidates.map((candidate) => candidate.blind_alias)).size,
  ).toBe(plan.candidates.length);
  expect(
    plan.jobs.every(
      (job) =>
        job.image_file.startsWith("images/ko-candidate-") &&
        !job.image_file.includes("mongtori"),
    ),
  ).toBe(true);
}

function assertFixtureMetadata(
  manifest: RenderManifest,
  report: RenderReport,
  marker: OwnershipMarker,
  manifestBytes: Buffer,
  reportBytes: Buffer,
) {
  expect(manifest.schema_version).toBe("font-render-bank-v1");
  expect(manifest).toMatchObject({
    family_count: 21,
    face_count: 37,
    candidate_count: 41,
    rendered_candidate_count: 1,
    generation: {
      limit: 2,
      partial: true,
      expected_render_count: 800,
      full_render_count: 800,
      production_asset_omitted_render_count: 0,
      complete_against_production_assets: false,
      rendered_count: 2,
    },
    renderer: {
      engine: "electron-chromium",
      production_stylesheet: "src/renderer/src/styles/fonts.css",
      production_stylesheet_loaded_via: "isolated-local-http-link",
    },
    candidate_identity_contract: {
      display_id_field: "candidate_display_id",
      blind_alias_field: "blind_alias",
      image_paths_expose_font_identity: false,
    },
  });
  expect(report.schema_version).toBe("font-render-bank-report-v1");
  expect(report.summary).toEqual({
    family_count: 21,
    face_count: 37,
    candidate_count: 41,
    rendered_candidate_count: 1,
    rendered_png_count: 2,
    fonts_ready_pass_count: 2,
    fallback_detection_pass_count: 2,
    qa_overlay_png_count: 0,
    production_unrenderable_face_count: 0,
    production_unrenderable_candidate_count: 0,
    production_asset_omitted_png_count: 0,
  });
  expect(report.manifest_sha256).toBe(sha256(manifestBytes));
  expect(marker).toMatchObject({
    owner: "carrot-manga-translator/font-render-bank",
    manifest_sha256: sha256(manifestBytes),
    report_sha256: sha256(reportBytes),
  });
}

function assertFixturePngs(output: string, manifest: RenderManifest) {
  expect(manifest.renders.map((render) => render.writing_mode)).toEqual([
    "horizontal",
    "vertical",
  ]);
  for (const render of manifest.renders) {
    expect(render.readiness).toMatchObject({
      document_fonts_ready: true,
      font_check_passed: true,
      production_font_check_passed: true,
      content_fits: true,
    });
    expect(render.fallback_detection.status).toBe("passed");
    expect(render.fallback_detection.metric_max_delta).toBeGreaterThan(0.01);
    expect(render.pixels.ink_pixel_count).toBeGreaterThan(16);
    expect(render.pixels.qa_overlay).toBe(false);
    expect(render.artifact.qa_overlay).toBe(false);
    const png = readFileSync(join(output, ...render.artifact.file.split("/")));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.length).toBe(render.artifact.byte_size);
    expect(sha256(png)).toBe(render.artifact.sha256);
    const expected =
      render.writing_mode === "vertical"
        ? { width: 224, height: 480 }
        : { width: 448, height: 224 };
    expect(render.artifact).toMatchObject(expected);
    expect(render.pixels.ink_bounds.min_x).toBeGreaterThanOrEqual(22);
    expect(render.pixels.ink_bounds.min_y).toBeGreaterThanOrEqual(22);
    expect(render.pixels.ink_bounds.max_x).toBeLessThanOrEqual(
      expected.width - 23,
    );
    expect(render.pixels.ink_bounds.max_y).toBeLessThanOrEqual(
      expected.height - 23,
    );
  }
}

function runGenerator(output: string, arguments_: string[]) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--output", output, ...arguments_],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 90_000,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
