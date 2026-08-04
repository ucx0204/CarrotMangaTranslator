import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAutoMatchActiveCandidateSelectionWith } from "../src/main/pipeline/autoMatchActiveCatalog";
import { parseAutoMatchActiveCatalog } from "../src/main/pipeline/autoMatchActiveCatalogContract";
import {
  AutoMatchActiveCatalogError,
  type AutoMatchActiveCatalogDependencies,
} from "../src/main/pipeline/autoMatchActiveCatalogTypes";
import {
  FONT_MATCHING_ACTIVE_CATALOG_RECORD,
  FONT_MATCHING_ACTIVE_CATALOG_SCHEMA,
} from "../src/main/pipeline/fontMatchingRuntimeArtifactContract";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const path = tempDirectories.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("active auto-match catalog", () => {
  it("orders only built-in candidates by the sealed active vocabulary", () => {
    const fixture = makeFixture();
    const selection = loadAutoMatchActiveCandidateSelectionWith({
      activeCatalogPath: fixture.catalogPath,
      builtInCandidates: [
        makeAutomaticFontCandidate({
          source: "built-in",
          fontId: "font-b",
          label: "B",
        }),
        makeAutomaticFontCandidate({ source: "custom", fontId: "custom-font" }),
        makeAutomaticFontCandidate({
          source: "built-in",
          fontId: "manual-only-font",
          label: "Manual only",
        }),
        makeAutomaticFontCandidate({
          source: "built-in",
          fontId: "font-a",
          label: "A",
        }),
      ],
      dependencies: fixture.dependencies,
      targetLocale: "ko",
    });

    expect(selection.candidates.map((candidate) => candidate.fontId)).toEqual([
      "font-a",
      "font-b",
    ]);
    expect(
      selection.installedCandidates.map((candidate) => candidate.candidateId),
    ).toEqual(["font-a", "font-b"]);
    expect(selection.installedCandidates[1].assets[0].resolvedFile).toMatch(
      /font-b-TestHash\.ttf$/u,
    );
  });

  it("fails closed when the installed bytes differ from the candidate asset SHA", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.assetPaths["font-a"], "tampered");

    expect(() =>
      loadAutoMatchActiveCandidateSelectionWith({
        activeCatalogPath: fixture.catalogPath,
        builtInCandidates: fixture.builtInCandidates,
        dependencies: fixture.dependencies,
        targetLocale: "ko",
      }),
    ).toThrowError(AutoMatchActiveCatalogError);
  });

  it("rejects a pending utility-audit disposition even when resealed", () => {
    const fixture = makeFixture();
    const record = JSON.parse(
      readFileSync(fixture.catalogPath, "utf8"),
    ) as Record<string, unknown>;
    const candidates = record.candidates as Array<Record<string, unknown>>;
    candidates[1].disposition = {
      action: "pending_full22_utility_audit",
      active_release_eligible: false,
      all_unrenderable: false,
      deployable_opportunity_count: 3,
      evidence_source: "v5_catalog_disposition",
      safe_count: 1,
      terminal: false,
    };
    writeFileSync(fixture.catalogPath, JSON.stringify(sealRecord(record)));

    expect(
      parseAutoMatchActiveCatalog(
        JSON.parse(readFileSync(fixture.catalogPath, "utf8")),
      ),
    ).toBeNull();
  });

  it("rejects candidate order changes that do not update the order SHA", () => {
    const fixture = makeFixture();
    const record = JSON.parse(
      readFileSync(fixture.catalogPath, "utf8"),
    ) as Record<string, unknown>;
    (record.candidate_ids as unknown[]).reverse();
    (record.candidates as unknown[]).reverse();

    expect(parseAutoMatchActiveCatalog(sealRecord(record))).toBeNull();
  });
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "active-font-catalog-"));
  tempDirectories.push(root);
  const bytesById = {
    "font-a": Buffer.from("font-a-installed-bytes"),
    "font-b": Buffer.from("font-b-installed-bytes"),
  };
  const assetPaths = {
    "font-a": join(root, "ko", "font-a.ttf"),
    "font-b": join(root, "font-b-TestHash.ttf"),
  };
  mkdirSync(join(root, "ko"));
  writeFileSync(assetPaths["font-a"], bytesById["font-a"]);
  writeFileSync(assetPaths["font-b"], bytesById["font-b"]);
  const candidate = (candidateId: keyof typeof bytesById, index: number) => ({
    assets: [
      {
        byte_size: bytesById[candidateId].byteLength,
        face_id: `${candidateId}:1:test`,
        file: `src/renderer/src/assets/fonts/ko/${candidateId}.ttf`,
        sha256: sha256(bytesById[candidateId]),
      },
    ],
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
  const ids = ["font-a", "font-b"];
  const record = sealRecord({
    candidate_count: ids.length,
    candidate_ids: ids,
    candidate_order_sha256: sha256(`${ids.join("\n")}\n`),
    candidates: ids.map((id, index) =>
      candidate(id as keyof typeof bytesById, index),
    ),
    catalog_version: "font-face-manifest-pruned-v5-test",
    excluded_candidates: [],
    locale: "ko",
    record_type: FONT_MATCHING_ACTIVE_CATALOG_RECORD,
    schema_version: FONT_MATCHING_ACTIVE_CATALOG_SCHEMA,
    source_records: {
      catalog_disposition_record_sha256: "a".repeat(64),
      deployment_font_face_manifest_sha256: "c".repeat(64),
      deployment_render_bank_manifest_sha256: "d".repeat(64),
      evidence_font_face_manifest_sha256: "e".repeat(64),
      evidence_render_bank_manifest_sha256: "f".repeat(64),
      final_catalog_record_sha256: "b".repeat(64),
    },
  });
  const catalogPath = join(root, "active.json");
  writeFileSync(catalogPath, JSON.stringify(record));
  const dependencies: AutoMatchActiveCatalogDependencies = {
    assetRoots: [root],
    readDirectory: (path) => readdirSync(path),
    readFile: (path) => readFileSync(path),
    realPath: (path) => realpathSync(path),
    statFile: (path) => statSync(path),
  };
  return {
    assetPaths,
    builtInCandidates: ids.map((fontId) =>
      makeAutomaticFontCandidate({ source: "built-in", fontId }),
    ),
    catalogPath,
    dependencies,
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
