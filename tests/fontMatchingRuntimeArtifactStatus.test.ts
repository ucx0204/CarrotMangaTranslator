import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FONT_MATCHING_RUNTIME_ARTIFACT_RECORD,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
  FONT_MATCHING_RUNTIME_CANDIDATE_IDS,
  FONT_MATCHING_RUNTIME_CANDIDATE_ORDER_SHA256,
  FONT_MATCHING_RUNTIME_ORT_VERSION,
} from "../src/main/pipeline/fontMatchingRuntimeArtifactContract";
import { loadFontMatchingRuntimeArtifactStatus } from "../src/main/pipeline/fontMatchingRuntimeArtifactStatus";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("font matching runtime artifact status", () => {
  it("keeps a fully verified bundle disabled until Electron pixel inference exists", async () => {
    const bundle = await writeBundle();

    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: bundle.root,
        installedCandidateIds: FONT_MATCHING_RUNTIME_CANDIDATE_IDS,
      }),
    ).resolves.toEqual({
      state: "disabled",
      automaticMutationAllowed: false,
      semanticBootstrapAllowed: false,
      reason: "runtime_inference_unavailable",
    });
  });

  it("reports a missing model explicitly without allowing bootstrap", async () => {
    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: null,
        installedCandidateIds: [],
      }),
    ).resolves.toEqual({
      state: "disabled",
      automaticMutationAllowed: false,
      semanticBootstrapAllowed: false,
      reason: "missing_artifact",
    });
  });

  it("hashes every bundle file instead of trusting a caller boolean", async () => {
    const bundle = await writeBundle();
    await writeFile(join(bundle.root, "prototype-features.f32"), "tampered");

    await expect(statusFor(bundle.root)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("recomputes the canonical contract record seal", async () => {
    const bundle = await writeBundle();
    bundle.contract.record_sha256 = "a".repeat(64);
    await rewriteContract(bundle.root, bundle.contract);

    await expect(statusFor(bundle.root)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("rejects a policy that permits semantic bootstrap", async () => {
    const bundle = await writeBundle();
    bundle.contract.deployment.fallback_policy.semantic_bootstrap = "shadow";
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle.root)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("requires the authoritative installed candidate order", async () => {
    const bundle = await writeBundle();

    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: bundle.root,
        installedCandidateIds: [
          ...FONT_MATCHING_RUNTIME_CANDIDATE_IDS,
        ].reverse(),
      }),
    ).resolves.toMatchObject({ state: "disabled", reason: "catalog_mismatch" });
  });

  it("rejects runtime version drift", async () => {
    const bundle = await writeBundle();

    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: bundle.root,
        installedCandidateIds: FONT_MATCHING_RUNTIME_CANDIDATE_IDS,
        onnxRuntimeVersion: "1.28.0",
      }),
    ).resolves.toMatchObject({
      state: "disabled",
      reason: "runtime_version_mismatch",
    });
  });
});

async function statusFor(root: string) {
  return loadFontMatchingRuntimeArtifactStatus({
    artifactDir: root,
    installedCandidateIds: FONT_MATCHING_RUNTIME_CANDIDATE_IDS,
  });
}

async function writeBundle() {
  const root = await mkdtemp(join(tmpdir(), "font-runtime-status-"));
  tempDirs.push(root);
  await mkdir(root, { recursive: true });
  const fileBytes = {
    "encoder.onnx": Buffer.from("encoder"),
    "ranker.onnx": Buffer.from("ranker"),
    "prototype-features.f32": Buffer.from("prototypes"),
  };
  for (const [file, bytes] of Object.entries(fileBytes)) {
    await writeFile(join(root, file), bytes);
  }
  const contract = sealRecord(makeContract(fileBytes));
  await writeFile(
    join(root, "runtime-contract.json"),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  await writeMarker(root);
  return { root, contract };
}

async function rewriteContract(
  root: string,
  contract: ReturnType<typeof makeContract>,
) {
  await writeFile(
    join(root, "runtime-contract.json"),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  await writeMarker(root);
}

async function writeMarker(root: string) {
  const files = [
    "encoder.onnx",
    "ranker.onnx",
    "prototype-features.f32",
    "runtime-contract.json",
  ];
  const artifacts = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        sha256(await readFile(join(root, file))),
      ]),
    ),
  );
  await writeFile(
    join(root, ".font-matching-runtime-artifact-owned.json"),
    `${JSON.stringify({
      artifacts,
      owner: "carrot-manga-translator/font-matching-runtime-artifact",
      safe_replace: true,
      schema_version: FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
    })}\n`,
  );
}

function makeContract(fileBytes: Record<string, Buffer>) {
  const descriptor = (file: keyof typeof fileBytes) => ({
    byte_size: fileBytes[file].byteLength,
    file,
    sha256: sha256(fileBytes[file]),
  });
  return {
    schema_version: FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
    record_type: FONT_MATCHING_RUNTIME_ARTIFACT_RECORD,
    record_sha256: "",
    model_version: "font-matching-runtime-v1-test",
    artifacts: {
      "encoder.onnx": descriptor("encoder.onnx"),
      "ranker.onnx": descriptor("ranker.onnx"),
      "prototype-features.f32": descriptor("prototype-features.f32"),
    },
    calibration: {
      calibration_split: "val",
      temperature: 0.75,
      none_threshold: 0.2,
    },
    catalog: {
      candidate_count: FONT_MATCHING_RUNTIME_CANDIDATE_IDS.length,
      candidate_ids: [...FONT_MATCHING_RUNTIME_CANDIDATE_IDS],
      candidate_order_sha256: FONT_MATCHING_RUNTIME_CANDIDATE_ORDER_SHA256,
      candidate_parameterization: "prototype-bag-only-no-id-embedding-or-bias",
      catalog_registry_sha256: "b".repeat(64),
      font_catalog_sha256: "c".repeat(64),
      font_prototypes_sha256: "d".repeat(64),
      render_bank_manifest_sha256: "e".repeat(64),
    },
    deployment: {
      state: "ready",
      automatic_mutation_allowed: true,
      fail_closed: true,
      fallback_policy: {
        automatic_profile_without_pixel_model: "forbidden",
        invalid_artifact: "explicit_disabled",
        manual_user_lock: "allowed",
        missing_artifact: "explicit_disabled",
        semantic_bootstrap: "forbidden",
      },
    },
    policy: {
      chapter_prior: {
        mode: "weak_prior_never_hard_constraint",
        scope: "chapter",
        real_local_change_overrides_prior: true,
        maximum_score_contribution: 0.08,
        minimum_anchor_evidence_count: 20,
        local_override_minimum_score_margin: 0.1,
      },
    },
    runtime: {
      package: "onnxruntime-web",
      execution_provider: "wasm",
      version: FONT_MATCHING_RUNTIME_ORT_VERSION,
    },
    test_data_boundary: {
      aggregate_metrics_only: true,
      frozen_test_pixels_opened_by_exporter: 0,
      row_level_predictions_packaged: false,
      sample_identifiers_packaged: false,
      training_or_validation_pixels_packaged: false,
    },
  };
}

function sealRecord<T extends Record<string, unknown>>(record: T): T {
  const core = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "record_sha256"),
  );
  return { ...record, record_sha256: sha256(canonicalJson(core)) };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
