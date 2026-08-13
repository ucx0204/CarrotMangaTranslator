import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstalledAutoMatchCandidate } from "../src/main/pipeline/autoMatchActiveCatalogTypes";
import {
  FONT_MATCHING_ACTIVE_CATALOG_FILE,
  FONT_MATCHING_ACTIVE_CATALOG_RECORD,
  FONT_MATCHING_ACTIVE_CATALOG_SCHEMA,
  FONT_MATCHING_RUNTIME_ARTIFACT_RECORD,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2,
  FONT_MATCHING_RUNTIME_ORT_VERSION,
  FONT_MATCHING_SELECTION_CALIBRATION_FILE,
} from "../src/main/pipeline/fontMatchingRuntimeArtifactContract";
import {
  readVerifiedRuntimeArtifactBundle,
  type VerifiedRuntimeArtifactBundle,
} from "../src/main/pipeline/fontMatchingRuntimeArtifactBundleLoader";
import {
  loadFontMatchingRuntimeArtifactStatus,
  projectFontMatchingRuntimeArtifactStatus,
} from "../src/main/pipeline/fontMatchingRuntimeArtifactStatus";

const tempDirs: string[] = [];
const candidateIds = ["font-a", "font-b"] as const;

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("font matching runtime artifact status", () => {
  it("returns calibrated ready status for a fully verified dynamic bundle", async () => {
    const bundle = await writeBundle();

    await expect(statusFor(bundle)).resolves.toEqual({
      state: "ready",
      automaticMutationAllowed: true,
      semanticBootstrapAllowed: false,
      modelVersion: "font-matching-runtime-v1-test",
      catalogVersion: "font-face-manifest-pruned-v5-test",
      candidateIds: [...candidateIds],
      candidateOrderSha256: candidateOrderSha256(candidateIds),
      calibration: { temperature: 0.75, noneThreshold: 0.2 },
      policy: {
        automaticMutation: {
          minimumAutomaticConfidence: 0.86,
          minimumRoleConfidence: 0.82,
          minimumIntentionalOverrideConfidence: 0.86,
          intentionalOverrideMinimumScoreMargin: 0.1,
        },
        chapterPrior: {
          maximumScoreContribution: 0.08,
          minimumAnchorEvidenceCount: 20,
          localOverrideMinimumScoreMargin: 0.1,
        },
      },
    });
  });

  it("accepts downloader cache sidecars for verified bundle files", async () => {
    const bundle = await writeBundle();
    const bundleFiles = [
      ".font-matching-runtime-artifact-owned.json",
      "runtime-contract.json",
      FONT_MATCHING_ACTIVE_CATALOG_FILE,
      FONT_MATCHING_SELECTION_CALIBRATION_FILE,
      "encoder.onnx",
      "ranker.onnx",
      "prototype-features.f32",
    ];
    await Promise.all(
      bundleFiles.flatMap((fileName) => [
        writeFile(join(bundle.root, `${fileName}.mgtmeta.json`), "{}"),
        writeFile(join(bundle.root, `${fileName}.mgt-sha256.json`), "{}"),
      ]),
    );

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "ready",
      automaticMutationAllowed: true,
    });
  });

  it("still rejects unrelated downloader-like sidecars", async () => {
    const bundle = await writeBundle();
    await writeFile(join(bundle.root, "unrelated.mgtmeta.json"), "{}");

    await expect(
      readVerifiedRuntimeArtifactBundle(bundle.root),
    ).rejects.toMatchObject({ reason: "artifact_verification_failed" });
  });

  it("accepts the sealed v2 hybrid owner and exact score-routing contract", async () => {
    const bundle = await writeBundle();
    bundle.contract.schema_version = FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2;
    (bundle.contract as Record<string, unknown>).hybrid_score_routing =
      makeHybridScoreRouting();
    (bundle.contract as Record<string, unknown>).runtime_batching =
      makeHybridRuntimeBatching();
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "ready",
      automaticMutationAllowed: true,
      modelVersion: "font-matching-runtime-v1-test",
    });
    const verified = await readVerifiedRuntimeArtifactBundle(bundle.root);
    expect(verified.schemaVersion).toBe(
      FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2,
    );
  });

  it("requires an explicit flag for an exactly marked QA-only runtime", async () => {
    const bundle = await writeBundle();
    await rewriteMarker(bundle.root, {
      qa_only: true,
      release_approved: false,
    });

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
    await expect(
      readVerifiedRuntimeArtifactBundle(bundle.root),
    ).rejects.toMatchObject({ reason: "artifact_verification_failed" });
    await expect(statusFor(bundle, true)).resolves.toMatchObject({
      state: "ready",
      automaticMutationAllowed: true,
    });
    const verified = await readVerifiedRuntimeArtifactBundle(bundle.root, {
      allowQaOnlyRuntime: true,
    });
    expect(verified.qaOnly).toBe(true);
  });

  it("never opens an evaluation-only bypass on the production status path", async () => {
    const bundle = await writeBundle();
    delete (bundle.contract as Record<string, unknown>).release_acceptance;
    (bundle.contract as Record<string, unknown>).evaluation_only_runtime = {
      schema_version: "font-matching-evaluation-only-runtime-v1",
      evaluation_only: true,
      non_promotable: true,
      quality_gate_bypassed: true,
      release_acceptance_forbidden: true,
      release_approved: false,
      loader_opt_in_required: "allowQaOnlyRuntime",
    };
    (bundle.contract as Record<string, unknown>).v8_runtime_packaging = {
      evaluation_only: true,
      non_promotable: true,
      quality_gate_bypassed: true,
      qa_only: true,
      release_approved: false,
      loader_opt_in_required: "allowQaOnlyRuntime",
    };
    await rewriteContract(bundle.root, sealRecord(bundle.contract));
    await rewriteMarker(bundle.root, {
      qa_only: true,
      release_approved: false,
    });

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      automaticMutationAllowed: false,
      reason: "artifact_verification_failed",
    });
    await expect(statusFor(bundle, true)).resolves.toMatchObject({
      state: "ready",
      automaticMutationAllowed: true,
    });
  });

  it("rejects ambiguous QA-only marker flags even with permission", async () => {
    const bundle = await writeBundle();
    await rewriteMarker(bundle.root, {
      qa_only: true,
      release_approved: true,
    });

    await expect(statusFor(bundle, true)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("recognizes an exactly sealed external release acceptance", async () => {
    const bundle = await writeBundle();
    (bundle.contract as Record<string, unknown>).release_acceptance =
      makeReleaseAcceptance();
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    const verified = await readVerifiedRuntimeArtifactBundle(bundle.root);

    expect(verified.qaOnly).toBe(false);
    expect(verified.releaseAccepted).toBe(true);
    expect(verified.failedCalibrationQualityAccepted).toBe(false);
  });

  it("recognizes only the fixed manually accepted r3h v2 envelope", async () => {
    const bundle = await writeBundle();
    (bundle.contract as Record<string, unknown>).release_acceptance =
      makeManualV2ReleaseAcceptance();
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    const verified = await readVerifiedRuntimeArtifactBundle(bundle.root);

    expect(verified.releaseAccepted).toBe(true);
    expect(verified.failedCalibrationQualityAccepted).toBe(true);
  });

  it("rejects a resealed manual-v2 acceptance with weaker page evidence", async () => {
    const bundle = await writeBundle();
    const acceptance = makeManualV2ReleaseAcceptance();
    const gate = acceptance.quality_gate as Record<string, unknown>;
    gate.usable_pages = 24;
    (bundle.contract as Record<string, unknown>).release_acceptance =
      sealRecord(acceptance);
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(
      readVerifiedRuntimeArtifactBundle(bundle.root),
    ).rejects.toMatchObject({ reason: "artifact_verification_failed" });
  });

  it("keeps an unaccepted production runtime disabled", async () => {
    const bundle = await writeBundle();
    delete (bundle.contract as Record<string, unknown>).release_acceptance;
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      automaticMutationAllowed: false,
      reason: "release_not_accepted",
    });
  });

  it("fails closed when the nested release acceptance seal is tampered", async () => {
    const bundle = await writeBundle();
    const acceptance = makeReleaseAcceptance();
    (acceptance as Record<string, unknown>).record_sha256 = "0".repeat(64);
    (bundle.contract as Record<string, unknown>).release_acceptance =
      acceptance;
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(
      readVerifiedRuntimeArtifactBundle(bundle.root),
    ).rejects.toMatchObject({ reason: "artifact_verification_failed" });
  });

  it("fails closed when a resealed release acceptance misses the 80-page gate", async () => {
    const bundle = await writeBundle();
    const acceptance = makeReleaseAcceptance();
    const qualityGate = acceptance.quality_gate as Record<string, unknown>;
    qualityGate.manual_page_verdicts = { accepted: 79, total: 80 };
    (bundle.contract as Record<string, unknown>).release_acceptance =
      sealRecord(acceptance);
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(
      readVerifiedRuntimeArtifactBundle(bundle.root),
    ).rejects.toMatchObject({ reason: "artifact_verification_failed" });
  });

  it("rejects v2 hybrid routing vocabulary drift", async () => {
    const bundle = await writeBundle();
    bundle.contract.schema_version = FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2;
    (bundle.contract as Record<string, unknown>).hybrid_score_routing = {
      ...makeHybridScoreRouting(),
      unknown_role_fallback: "body_candidate_scores",
    };
    (bundle.contract as Record<string, unknown>).runtime_batching =
      makeHybridRuntimeBatching();
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("rejects a resealed runtime contract with envelope vocabulary drift", async () => {
    const bundle = await writeBundle();
    bundle.contract.record_type = "font_matching_runtime_artifact_typo";
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("reports a missing model explicitly without allowing bootstrap", async () => {
    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: null,
        installedCandidates: [],
      }),
    ).resolves.toEqual({
      state: "disabled",
      automaticMutationAllowed: false,
      semanticBootstrapAllowed: false,
      reason: "missing_artifact",
    });
  });

  it("hashes every bundle file instead of trusting the marker", async () => {
    const bundle = await writeBundle();
    await writeFile(join(bundle.root, "prototype-features.f32"), "tampered");

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("projects status from detached verified bytes without reopening the artifact", async () => {
    const bundle = await writeBundle();
    const verifiedBundle = await readVerifiedRuntimeArtifactBundle(bundle.root);
    await writeFile(join(bundle.root, "prototype-features.f32"), "tampered");

    await expect(
      projectFontMatchingRuntimeArtifactStatus({
        verifiedBundle,
        installedCandidates: bundle.installedCandidates,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      automaticMutationAllowed: true,
    });
    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("rejects a structurally forged verified-bundle receipt", async () => {
    const bundle = await writeBundle();
    const verifiedBundle = await readVerifiedRuntimeArtifactBundle(bundle.root);
    expect(Object.isFrozen(verifiedBundle)).toBe(true);
    expect(Object.isFrozen(verifiedBundle.contract)).toBe(true);
    expect(Object.isFrozen(verifiedBundle.activeCatalog)).toBe(true);
    expect(
      Object.values(verifiedBundle.assets).every((asset) =>
        Object.isFrozen(asset),
      ),
    ).toBe(true);
    const forgedBundle = {
      ...verifiedBundle,
    } as VerifiedRuntimeArtifactBundle;

    await expect(
      projectFontMatchingRuntimeArtifactStatus({
        verifiedBundle: forgedBundle,
        installedCandidates: bundle.installedCandidates,
      }),
    ).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("returns the marker-verified selection calibration bytes", async () => {
    const bundle = await writeBundle();

    const verified = await readVerifiedRuntimeArtifactBundle(bundle.root);

    expect(
      Buffer.from(
        verified.assetBytes[FONT_MATCHING_SELECTION_CALIBRATION_FILE] ?? [],
      ),
    ).toEqual(bundle.selectionCalibrationBytes);
  });

  it("fails closed when the selection calibration bytes are tampered", async () => {
    const bundle = await writeBundle();
    await writeFile(
      join(bundle.root, FONT_MATCHING_SELECTION_CALIBRATION_FILE),
      "tampered",
    );

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("requires the selection calibration contract descriptor", async () => {
    const bundle = await writeBundle();
    delete (bundle.contract.artifacts as Record<string, unknown>)[
      FONT_MATCHING_SELECTION_CALIBRATION_FILE
    ];
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("verifies the active catalog seal and its marker binding", async () => {
    const bundle = await writeBundle();
    const activePath = join(bundle.root, FONT_MATCHING_ACTIVE_CATALOG_FILE);
    const active = JSON.parse(await readFile(activePath, "utf8")) as Record<
      string,
      unknown
    >;
    active.record_sha256 = "a".repeat(64);
    await writeFile(activePath, `${JSON.stringify(active, null, 2)}\n`);
    await rewriteMarker(bundle.root);

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("recomputes the canonical runtime contract seal", async () => {
    const bundle = await writeBundle();
    bundle.contract.record_sha256 = "a".repeat(64);
    await rewriteContract(bundle.root, bundle.contract);

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "artifact_verification_failed",
    });
  });

  it("verifies Python float lexemes in the sealed runtime contract", async () => {
    const bundle = await writeBundle();
    bundle.contract.calibration.temperature = 1;
    bundle.contract.policy.chapter_prior.local_override_minimum_score_margin = 1.266e-6;
    const pythonJson = pythonStyleRuntimeContractJson(bundle.contract);
    expect(pythonJson).toContain('"temperature": 1.0');
    expect(pythonJson).toContain(
      '"local_override_minimum_score_margin": 1.266e-06',
    );
    await writeFile(join(bundle.root, "runtime-contract.json"), pythonJson);
    await rewriteMarker(bundle.root);

    const verified = await readVerifiedRuntimeArtifactBundle(bundle.root);

    expect(
      (verified.contract.calibration as Record<string, unknown>).temperature,
    ).toBe(1);
    expect(
      (
        (verified.contract.policy as Record<string, unknown>)[
          "chapter_prior"
        ] as Record<string, unknown>
      ).local_override_minimum_score_margin,
    ).toBe(1.266e-6);
  });

  it("rejects a Python-number spelling change without a new record seal", async () => {
    const bundle = await writeBundle();
    bundle.contract.calibration.temperature = 1;
    bundle.contract.policy.chapter_prior.local_override_minimum_score_margin = 1.266e-6;
    const pythonJson = pythonStyleRuntimeContractJson(bundle.contract);
    await writeFile(
      join(bundle.root, "runtime-contract.json"),
      pythonJson.replace('"temperature": 1.0', '"temperature": 1.00'),
    );
    await rewriteMarker(bundle.root);

    await expect(
      readVerifiedRuntimeArtifactBundle(bundle.root),
    ).rejects.toMatchObject({ reason: "artifact_verification_failed" });
  });

  it("rejects a policy that permits semantic bootstrap", async () => {
    const bundle = await writeBundle();
    bundle.contract.deployment.fallback_policy.semantic_bootstrap = "shadow";
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("rejects missing automatic-mutation policy instead of using app defaults", async () => {
    const bundle = await writeBundle();
    delete (bundle.contract.policy as Record<string, unknown>)
      .automatic_mutation;
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("rejects policy vocabulary drift and unsafe requirement changes", async () => {
    const bundle = await writeBundle();
    const automatic = bundle.contract.policy.automatic_mutation as Record<
      string,
      unknown
    >;
    automatic.require_runtime_artifact_ready = false;
    automatic.silent_fallback = true;
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("requires the sealed lowercase policy SHA-256 field", async () => {
    const bundle = await writeBundle();
    bundle.contract.policy.policy_sha256 = "A".repeat(64);
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("requires the exact installed active-candidate order", async () => {
    const bundle = await writeBundle();

    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: bundle.root,
        installedCandidates: [...bundle.installedCandidates].reverse(),
      }),
    ).resolves.toMatchObject({ state: "disabled", reason: "catalog_mismatch" });
  });

  it("hashes each installed candidate asset from its actual file", async () => {
    const bundle = await writeBundle();
    await writeFile(
      bundle.installedCandidates[1].assets[0].resolvedFile,
      "same-descriptor-but-tampered-bytes",
    );

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "catalog_mismatch",
    });
  });

  it("fails closed when an installed candidate asset disappears", async () => {
    const bundle = await writeBundle();
    await rm(bundle.installedCandidates[0].assets[0].resolvedFile);

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "catalog_mismatch",
    });
  });

  it("trusts the preverified snapshot when on-disk asset reverification is skipped (worker_threads path)", async () => {
    const bundle = await writeBundle();
    // Built-in font files live inside app.asar, which a worker_threads worker
    // cannot read (Electron's asar `fs` patches are main-process only). The
    // worker passes reverifyInstalledAssetBytes:false and trusts the snapshot
    // the main process already verified, so unreadable/tampered bytes on disk
    // must NOT disable matching — only the structural catalog check runs.
    await writeFile(
      bundle.installedCandidates[1].assets[0].resolvedFile,
      "same-descriptor-but-tampered-bytes",
    );

    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: bundle.root,
        installedCandidates: bundle.installedCandidates,
        reverifyInstalledAssetBytes: false,
      }),
    ).resolves.toMatchObject({ state: "ready" });

    // The structural check still runs: a reordered candidate snapshot still
    // fails closed even with on-disk reverification skipped.
    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: bundle.root,
        installedCandidates: [...bundle.installedCandidates].reverse(),
        reverifyInstalledAssetBytes: false,
      }),
    ).resolves.toMatchObject({
      state: "disabled",
      reason: "catalog_mismatch",
    });
  });

  it("rejects contract vocabulary drift from the bundled active catalog", async () => {
    const bundle = await writeBundle();
    bundle.contract.catalog.candidate_ids = [...candidateIds].reverse();
    bundle.contract.catalog.candidate_order_sha256 = candidateOrderSha256(
      bundle.contract.catalog.candidate_ids,
    );
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("rejects a contract catalog version that differs from the active catalog", async () => {
    const bundle = await writeBundle();
    bundle.contract.catalog.catalog_version = "stale-active-catalog";
    await rewriteContract(bundle.root, sealRecord(bundle.contract));

    await expect(statusFor(bundle)).resolves.toMatchObject({
      state: "disabled",
      reason: "invalid_contract",
    });
  });

  it("rejects runtime version drift", async () => {
    const bundle = await writeBundle();

    await expect(
      loadFontMatchingRuntimeArtifactStatus({
        artifactDir: bundle.root,
        installedCandidates: bundle.installedCandidates,
        onnxRuntimeVersion: "1.28.0",
      }),
    ).resolves.toMatchObject({
      state: "disabled",
      reason: "runtime_version_mismatch",
    });
  });
});

async function statusFor(
  bundle: Awaited<ReturnType<typeof writeBundle>>,
  allowQaOnlyRuntime = false,
) {
  return loadFontMatchingRuntimeArtifactStatus({
    artifactDir: bundle.root,
    installedCandidates: bundle.installedCandidates,
    allowQaOnlyRuntime,
  });
}

async function writeBundle() {
  const root = await mkdtemp(join(tmpdir(), "font-runtime-status-"));
  tempDirs.push(root);
  const installedRoot = await mkdtemp(join(tmpdir(), "font-runtime-fonts-"));
  tempDirs.push(installedRoot);
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(installedRoot, { recursive: true }),
  ]);

  const installedCandidates: InstalledAutoMatchCandidate[] = [];
  const activeCandidates = [];
  for (const [index, candidateId] of candidateIds.entries()) {
    const bytes = Buffer.from(`installed-${candidateId}`);
    const sourceFile = `src/renderer/src/assets/fonts/ko/${candidateId}.ttf`;
    const resolvedFile = join(installedRoot, `${candidateId}.ttf`);
    await writeFile(resolvedFile, bytes);
    const asset = {
      byte_size: bytes.byteLength,
      face_id: `${candidateId}:1:test`,
      file: sourceFile,
      sha256: sha256(bytes),
    };
    activeCandidates.push({
      assets: [asset],
      candidate_id: candidateId,
      disposition:
        index === 0
          ? {
              action: "prior_production_catalog",
              active_release_eligible: true,
              all_unrenderable: false,
              deployable_opportunity_count: null,
              evidence_source: "prior_production_catalog",
              safe_count: null,
              terminal: true,
            }
          : {
              action: "retained_unique_p1",
              active_release_eligible: true,
              all_unrenderable: false,
              deployable_opportunity_count: 3,
              evidence_source: "v5_catalog_disposition",
              safe_count: 1,
              terminal: true,
            },
    });
    installedCandidates.push({
      candidateId,
      assets: [
        {
          byteSize: bytes.byteLength,
          faceId: asset.face_id,
          file: sourceFile,
          resolvedFile,
          sha256: asset.sha256,
        },
      ],
    });
  }
  const activeCatalog = sealRecord({
    candidate_count: candidateIds.length,
    candidate_ids: [...candidateIds],
    candidate_order_sha256: candidateOrderSha256(candidateIds),
    candidates: activeCandidates,
    catalog_version: "font-face-manifest-pruned-v5-test",
    excluded_candidates: [],
    locale: "ko",
    record_type: FONT_MATCHING_ACTIVE_CATALOG_RECORD,
    schema_version: FONT_MATCHING_ACTIVE_CATALOG_SCHEMA,
    source_records: {
      catalog_disposition_record_sha256: "b".repeat(64),
      deployment_font_face_manifest_sha256: "d".repeat(64),
      deployment_render_bank_manifest_sha256: "e".repeat(64),
      evidence_font_face_manifest_sha256: "1".repeat(64),
      evidence_render_bank_manifest_sha256: "2".repeat(64),
      final_catalog_record_sha256: "c".repeat(64),
    },
  });
  const activeBytes = Buffer.from(
    `${JSON.stringify(activeCatalog, null, 2)}\n`,
  );
  const selectionCalibrationBytes = Buffer.from(
    '{"schema_version":"font-matching-selection-calibration-v1"}\n',
  );
  await writeFile(join(root, FONT_MATCHING_ACTIVE_CATALOG_FILE), activeBytes);
  const fileBytes = {
    [FONT_MATCHING_ACTIVE_CATALOG_FILE]: activeBytes,
    [FONT_MATCHING_SELECTION_CALIBRATION_FILE]: selectionCalibrationBytes,
    "encoder.onnx": Buffer.from("encoder"),
    "ranker.onnx": Buffer.from("ranker"),
    "prototype-features.f32": Buffer.from("prototypes"),
  };
  for (const [file, bytes] of Object.entries(fileBytes)) {
    if (file !== FONT_MATCHING_ACTIVE_CATALOG_FILE) {
      await writeFile(join(root, file), bytes);
    }
  }
  const contract = sealRecord(makeContract(fileBytes, activeCatalog));
  await writeFile(
    join(root, "runtime-contract.json"),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  await rewriteMarker(root);
  return { root, contract, installedCandidates, selectionCalibrationBytes };
}

async function rewriteContract(
  root: string,
  contract: ReturnType<typeof makeContract>,
) {
  await writeFile(
    join(root, "runtime-contract.json"),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  await rewriteMarker(root);
}

async function rewriteMarker(
  root: string,
  markerOverrides: Record<string, unknown> = {},
) {
  const files = [
    FONT_MATCHING_ACTIVE_CATALOG_FILE,
    FONT_MATCHING_SELECTION_CALIBRATION_FILE,
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
  const contract = JSON.parse(
    await readFile(join(root, "runtime-contract.json"), "utf8"),
  ) as Record<string, unknown>;
  const schemaVersion = contract.schema_version;
  const owner =
    schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2
      ? "carrot-manga-translator/font-matching-runtime-artifact-v2"
      : "carrot-manga-translator/font-matching-runtime-artifact";
  await writeFile(
    join(root, ".font-matching-runtime-artifact-owned.json"),
    `${JSON.stringify({
      artifacts,
      owner,
      safe_replace: true,
      schema_version: schemaVersion,
      ...markerOverrides,
    })}\n`,
  );
}

function makeHybridScoreRouting() {
  return {
    schema_version: "font-matching-hybrid-score-routing-v1",
    candidate_scores_compatibility_alias: "body_candidate_scores",
    body_candidate_output: "body_candidate_scores",
    variant_candidate_output: "variant_candidate_scores",
    body_roles: ["dialogue", "narration", "thought"],
    variant_roles: [
      "whisper",
      "aside_balloon_edge",
      "emphasis_dialogue",
      "shout",
      "sfx_impact",
      "sfx_motion",
      "sfx_ambient",
      "sfx_emotion",
      "sfx_comic",
      "sign_ui_title",
      "other",
    ],
    unknown_role_fallback: "variant_candidate_scores",
    role_source: "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
    selection_feature_source:
      "selected_candidate_scores_with_legacy256_visual_features",
    selection_feature_dim: 256,
    row_specific_rules: false,
  };
}

function makeHybridRuntimeBatching() {
  return {
    encoder_batch_size: 2,
    ranker_batch_size: 16,
    parity_qualified: true,
  };
}

function makeContract(
  fileBytes: Record<string, Buffer>,
  activeCatalog: Record<string, unknown>,
) {
  const descriptor = (file: keyof typeof fileBytes) => ({
    byte_size: fileBytes[file].byteLength,
    file,
    sha256: sha256(fileBytes[file]),
  });
  const sourceRecords = activeCatalog.source_records as Record<string, string>;
  return {
    schema_version: FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
    record_type: FONT_MATCHING_RUNTIME_ARTIFACT_RECORD,
    record_sha256: "",
    model_version: "font-matching-runtime-v1-test",
    artifacts: Object.fromEntries(
      Object.keys(fileBytes).map((file) => [file, descriptor(file)]),
    ),
    calibration: {
      calibration_split: "val",
      temperature: 0.75,
      none_threshold: 0.2,
    },
    catalog: {
      active_catalog_record_sha256: activeCatalog.record_sha256,
      candidate_count: candidateIds.length,
      candidate_ids: [...candidateIds],
      candidate_order_sha256: candidateOrderSha256(candidateIds),
      candidate_parameterization: "prototype-bag-only-no-id-embedding-or-bias",
      catalog_disposition_record_sha256:
        sourceRecords.catalog_disposition_record_sha256,
      catalog_registry_sha256: "a".repeat(64),
      catalog_version: activeCatalog.catalog_version,
      final_catalog_record_sha256: sourceRecords.final_catalog_record_sha256,
      font_catalog_sha256: sourceRecords.deployment_font_face_manifest_sha256,
      font_prototypes_sha256: "f".repeat(64),
      render_bank_manifest_sha256:
        sourceRecords.deployment_render_bank_manifest_sha256,
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
    release_acceptance: makeReleaseAcceptance(),
    policy: {
      policy_sha256: "9".repeat(64),
      automatic_mutation: {
        intentional_override_minimum_score_margin: 0.1,
        minimum_calibrated_confidence: 0.86,
        minimum_intentional_override_confidence: 0.86,
        minimum_role_confidence: 0.82,
        require_none_acceptable_false: true,
        require_runtime_artifact_ready: true,
        require_translation_glyph_coverage: true,
      },
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

function makeReleaseAcceptance() {
  return sealRecord({
    schema_version: "font-matching-runtime-release-acceptance-v1",
    record_type: "font_matching_runtime_release_acceptance",
    status: "accepted",
    external_release_quality_gate_passed: true,
    automatic_visual_judgment: false,
    quality_gate: {
      structural_error_count: 0,
      manual_page_verdicts: { accepted: 80, total: 80 },
    },
  });
}

function makeManualV2ReleaseAcceptance() {
  const modelVersion = "manga-font-v8-active21-dfa42ae17f-ffb3285338";
  return sealRecord({
    schema_version: "font-matching-runtime-release-acceptance-v2",
    record_type: "font_matching_runtime_release_acceptance",
    status: "accepted",
    acceptance_authority:
      "explicit_user_approved_work_disjoint_fresh_gemma_manual_visual_review",
    accepted_at: "2026-08-12T03:00:00Z",
    automatic_visual_judgment: false,
    explicit_user_acceptance: true,
    external_release_quality_gate_passed: true,
    evidence: {
      adapter_checkpoint_sha256:
        "ff580ef87c949d9b5cc8f4552490015cb621814d6cd5c122018def415792f3de",
      candidate_order_sha256:
        "17343ec15ee2153e770101d0cbf707600e97a8bc2d490496efaf4da2f638437d",
      cohort_digest:
        "9c1ddde045ab0ddbad1e86fa30c20b869a112a9405eddbe404b0d1292686f5d2",
      manual_review_content_sha256:
        "39e45f037d15dd42f3aa74ee987a0e272d308c13115036f182fc1a6f0dfe1157",
      manual_review_file_sha256:
        "a92a751168d0cbde436371c30e1dcfe613194b80d3eff9787df6b2375f3364eb",
      model_version: modelVersion,
      ranker_sha256:
        "dfa42ae17f340768cae30f2219973eae1ff62a4c3c1544496502621e6e710c78",
      run_report_sha256:
        "61570016f17039e982c05afb066c92bf649a5ac837d3e8254b847b96bb2d11cb",
      source_evaluation_runtime_contract_sha256:
        "292433b367a7aef5abd8d2b8c3833d521584bc4cb41027924c37774585fdb7f4",
      source_selection_calibration_sha256:
        "501c39cd12019e4334336c486a0b8a87699ea6a5e8845232af5537e0929dc3fb",
      visual_review_index_sha256:
        "5155436a1bf25e2e5694c4cc88d1f65092245e6bc80743484e604ef7984593ad",
    },
    publication: {
      evaluation_only_annotations_removed: true,
      release_marker_has_no_qa_flags: true,
      source_evaluation_runtime_immutable: true,
      source_model_assets_copied_exactly: true,
    },
    quality_gate: {
      acceptable_pages: 15,
      bad_pages: 5,
      calibration_gate_waiver: {
        approved: true,
        exact_scope: `${modelVersion}/r3h-manual-v2`,
        reason:
          "explicit_user_acceptance_after_fresh_work_disjoint_manual_review",
        strict_gate_failures: {
          global_acceptable_at1: 22 / 31,
          global_precision_target: 0.88,
          global_preferred_at1: 13 / 31,
          variant_acceptable_at1: 22 / 30,
          variant_precision_target: 0.88,
          variant_preferred_at1: 13 / 30,
        },
      },
      calibration_release_quality_gate_passed: false,
      distinct_chapters: 40,
      distinct_works: 10,
      fresh_work_disjoint_pages: 40,
      good_pages: 10,
      judged_content_pages: 30,
      master_work_overlap: 0,
      minimum_usable_rate: 0.8,
      outline_loss_count: 0,
      single_day_body_role_count: 0,
      structural_error_count: 0,
      usable_pages: 25,
      usable_rate: 25 / 30,
    },
  });
}

function pythonStyleRuntimeContractJson(
  record: ReturnType<typeof makeContract>,
): string {
  const core = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "record_sha256"),
  );
  const recordSha256 = sha256(withPythonFloatLexemes(canonicalJson(core)));
  return `${withPythonFloatLexemes(
    JSON.stringify({ ...core, record_sha256: recordSha256 }, null, 2),
  )}\n`;
}

function withPythonFloatLexemes(value: string): string {
  return value
    .replace(
      /("temperature":\s*)1(?=\s*[,}])/u,
      (_match, prefix: string) => `${prefix}1.0`,
    )
    .replace(
      /("local_override_minimum_score_margin":\s*)(?:0\.000001266|1\.266e-6)/u,
      (_match, prefix: string) => `${prefix}1.266e-06`,
    );
}

function candidateOrderSha256(ids: readonly string[]): string {
  return sha256(`${ids.join("\n")}\n`);
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
