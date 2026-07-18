import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTempDir,
  DEFAULT_12B_FILE,
  DEFAULT_12B_REPO,
} from "./helpers/runtimeModelContracts";

const {
  hasCurrentIntegrityMarker,
  integrityMarkerPath,
  normalizeExpectedSha256,
  verifyFileSha256,
} = require("../src/main/runtime/transport/download-integrity.cjs") as {
  hasCurrentIntegrityMarker: (filePath: string, sha256: string) => boolean;
  integrityMarkerPath: (filePath: string) => string;
  normalizeExpectedSha256: (value: unknown) => string;
  verifyFileSha256: (
    filePath: string,
    sha256: string,
  ) => Promise<{ verified: boolean; expected: string; actual: string }>;
};
const { removeInvalidMetalCachedAssets } =
  require("../src/main/runtime/model/hf-model-download.cjs") as {
    removeInvalidMetalCachedAssets: (
      options: Record<string, unknown>,
      target: Record<string, unknown>,
    ) => Promise<void>;
  };

describe("download integrity markers", () => {
  it("verifies a payload once and invalidates the marker when it changes", async () => {
    const filePath = join(createTempDir("download-integrity-"), "asset.bin");
    const payload = Buffer.from("verified model payload");
    const expected = createHash("sha256").update(payload).digest("hex");
    writeFileSync(filePath, payload);

    await expect(verifyFileSha256(filePath, expected)).resolves.toMatchObject({
      verified: true,
      expected,
      actual: expected,
    });
    expect(existsSync(integrityMarkerPath(filePath))).toBe(true);
    expect(hasCurrentIntegrityMarker(filePath, expected)).toBe(true);

    writeFileSync(filePath, Buffer.from("changed payload with another size"));
    expect(hasCurrentIntegrityMarker(filePath, expected)).toBe(false);
    await expect(verifyFileSha256(filePath, expected)).resolves.toMatchObject({
      verified: false,
      expected,
    });
  });

  it("removes a mismatched built-in cache before Metal can launch it", async () => {
    const cacheDir = createTempDir("metal-cache-integrity-");
    const modelPath = join(cacheDir, DEFAULT_12B_FILE);
    writeFileSync(modelPath, "corrupt cached model");

    await removeInvalidMetalCachedAssets(
      {
        llamaRuntimeProfile: "metal",
        modelSource: "huggingface",
        modelRepo: DEFAULT_12B_REPO,
        modelFile: DEFAULT_12B_FILE,
      },
      {
        launchMode: "cached-hf",
        modelPath,
        mmprojPath: null,
        draftModelPath: null,
        requiresDownload: false,
      },
    );

    expect(existsSync(modelPath)).toBe(false);
  });

  it("rejects malformed expected digests", () => {
    expect(normalizeExpectedSha256("not-a-digest")).toBe("");
    expect(normalizeExpectedSha256("A".repeat(64))).toBe("a".repeat(64));
  });
});
