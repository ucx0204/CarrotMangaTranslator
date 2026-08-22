import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFontMatchingReleaseAcceptance } from "../src/main/pipeline/fontMatchingRuntimeReleaseAcceptance";

const releaseContractPath = join(
  __dirname,
  "..",
  "artifacts",
  "font-matching-runtime-active21-v9-r33-page-common-user-v3-release-v2",
  "runtime-contract.json",
);
const committedReleaseContractJson = readFileSync(
  join(__dirname, "fixtures", "fontMatchingR33ReleaseAcceptance.json"),
  "utf8",
);

describe("R33 cached-page A/B release acceptance", () => {
  it("accepts the exact committed production acceptance record", () => {
    const contract = JSON.parse(committedReleaseContractJson) as Record<
      string,
      unknown
    >;

    expect(
      parseFontMatchingReleaseAcceptance(
        contract,
        committedReleaseContractJson,
      ),
    ).toEqual({
      accepted: true,
      failedCalibrationQualityAccepted: true,
    });
  });

  it("rejects a coherently resealed visual verdict drift", () => {
    const contract = JSON.parse(committedReleaseContractJson) as Record<
      string,
      unknown
    >;
    const acceptance = structuredClone(contract.release_acceptance) as Record<
      string,
      unknown
    >;
    const qualityGate = acceptance.quality_gate as Record<string, unknown>;
    qualityGate.improved_pages = 3;
    qualityGate.regressed_pages = 1;
    acceptance.record_sha256 = sealSha256(acceptance);
    contract.release_acceptance = acceptance;
    const contractJson = JSON.stringify(contract, null, 2);

    expect(
      parseFontMatchingReleaseAcceptance(contract, contractJson),
    ).toBeUndefined();
  });

  it.skipIf(!existsSync(releaseContractPath))(
    "matches the local full production contract when its ignored artifact is available",
    () => {
      const contractJson = readFileSync(releaseContractPath, "utf8");
      const contract = JSON.parse(contractJson) as Record<string, unknown>;
      expect(
        parseFontMatchingReleaseAcceptance(contract, contractJson),
      ).toEqual({
        accepted: true,
        failedCalibrationQualityAccepted: true,
      });
    },
  );
});

function sealSha256(record: Record<string, unknown>): string {
  const core = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "record_sha256"),
  );
  return createHash("sha256").update(canonicalJson(core)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
