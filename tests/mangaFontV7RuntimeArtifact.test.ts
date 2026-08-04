import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { InstalledAutoMatchCandidate } from "../src/main/pipeline/autoMatchActiveCatalogTypes";
import { FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2 } from "../src/main/pipeline/fontMatchingRuntimeArtifactContract";
import { readVerifiedRuntimeArtifactBundle } from "../src/main/pipeline/fontMatchingRuntimeArtifactBundleLoader";
import { loadFontMatchingRuntimeArtifactStatus } from "../src/main/pipeline/fontMatchingRuntimeArtifactStatus";

const workspace = resolve(import.meta.dirname, "..");
const artifactDir = resolve(
  workspace,
  "artifacts/manga-font-student-v7-active21-runtime-r3-fixture-v1",
);
const artifactAvailable = existsSync(
  resolve(artifactDir, ".font-matching-runtime-artifact-owned.json"),
);
const round1BaseArtifactDir = resolve(
  workspace,
  "artifacts/manga-font-student-v7-mass21-round1-runtime-base-v1",
);
const round1BaseArtifactAvailable = existsSync(
  resolve(round1BaseArtifactDir, ".font-matching-runtime-artifact-owned.json"),
);
const releaseArtifactDir = resolve(
  workspace,
  "artifacts/font-matching-runtime-active21-r5-e1-release-v1",
);
const releaseArtifactAvailable = existsSync(
  resolve(releaseArtifactDir, ".font-matching-runtime-artifact-owned.json"),
);

type RawActiveCatalog = Readonly<{
  candidate_ids: string[];
  candidates: Array<{
    candidate_id: string;
    assets: Array<{
      byte_size: number;
      face_id: string;
      file: string;
      sha256: string;
    }>;
  }>;
}>;

function installedCandidatesFor(
  directory: string,
): readonly InstalledAutoMatchCandidate[] {
  const rawCatalog = JSON.parse(
    readFileSync(resolve(directory, "auto-match-active-catalog.json"), "utf8"),
  ) as RawActiveCatalog;
  return rawCatalog.candidates.map((candidate) => ({
    candidateId: candidate.candidate_id,
    assets: candidate.assets.map((asset) => ({
      byteSize: asset.byte_size,
      faceId: asset.face_id,
      file: asset.file,
      resolvedFile: resolve(workspace, asset.file),
      sha256: asset.sha256,
    })),
  }));
}

describe.skipIf(!artifactAvailable)(
  "sealed MangaFont v7 active21 fixture",
  () => {
    it("verifies as QA-only and remains disabled until calibrated", async () => {
      const rawCatalog = JSON.parse(
        readFileSync(
          resolve(artifactDir, "auto-match-active-catalog.json"),
          "utf8",
        ),
      ) as RawActiveCatalog;
      const installedCandidates = installedCandidatesFor(artifactDir);

      await expect(
        readVerifiedRuntimeArtifactBundle(artifactDir),
      ).rejects.toMatchObject({ reason: "artifact_verification_failed" });
      const bundle = await readVerifiedRuntimeArtifactBundle(artifactDir, {
        allowQaOnlyRuntime: true,
      });
      expect(bundle.qaOnly).toBe(true);
      expect(bundle.activeCatalog.candidateIds).toEqual(
        rawCatalog.candidate_ids,
      );
      expect(bundle.activeCatalog.candidateIds).toHaveLength(21);
      expect(bundle.activeCatalog.candidateIds).not.toContain("gugi");

      await expect(
        loadFontMatchingRuntimeArtifactStatus({
          artifactDir,
          installedCandidates,
          allowQaOnlyRuntime: true,
        }),
      ).resolves.toMatchObject({
        state: "disabled",
        automaticMutationAllowed: false,
        reason: "invalid_contract",
      });
    });
  },
);

describe.skipIf(!releaseArtifactAvailable)(
  "sealed active21 R5-E1 release-v1 runtime",
  () => {
    it("loads without QA permission and enables automatic mutation", async () => {
      const bundle =
        await readVerifiedRuntimeArtifactBundle(releaseArtifactDir);

      expect(bundle.qaOnly).toBe(false);
      expect(bundle.schemaVersion).toBe(
        FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2,
      );
      expect(bundle.releaseAccepted).toBe(true);
      expect(bundle.activeCatalog.candidateIds).toHaveLength(21);
      expect(bundle.activeCatalog.candidateIds).not.toContain("gugi");
      await expect(
        loadFontMatchingRuntimeArtifactStatus({
          artifactDir: releaseArtifactDir,
          installedCandidates: installedCandidatesFor(releaseArtifactDir),
        }),
      ).resolves.toMatchObject({
        state: "ready",
        automaticMutationAllowed: true,
        semanticBootstrapAllowed: false,
      });
    });
  },
);

describe.skipIf(!round1BaseArtifactAvailable)(
  "sealed MangaFont v7 active21 round1 base runtime",
  () => {
    it("verifies the model but fails closed without release calibration", async () => {
      await expect(
        readVerifiedRuntimeArtifactBundle(round1BaseArtifactDir),
      ).rejects.toMatchObject({ reason: "artifact_verification_failed" });
      const bundle = await readVerifiedRuntimeArtifactBundle(
        round1BaseArtifactDir,
        { allowQaOnlyRuntime: true },
      );

      expect(bundle.qaOnly).toBe(true);
      expect(bundle.activeCatalog.candidateIds).toHaveLength(21);
      expect(bundle.activeCatalog.candidateIds).not.toContain("gugi");
      await expect(
        loadFontMatchingRuntimeArtifactStatus({
          artifactDir: round1BaseArtifactDir,
          installedCandidates: installedCandidatesFor(round1BaseArtifactDir),
          allowQaOnlyRuntime: true,
        }),
      ).resolves.toMatchObject({
        state: "disabled",
        automaticMutationAllowed: false,
        reason: "invalid_contract",
      });
    });
  },
);
