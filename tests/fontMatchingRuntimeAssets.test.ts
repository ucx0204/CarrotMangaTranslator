import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FONT_MATCHING_RUNTIME_BASE_URL,
  FONT_MATCHING_RUNTIME_FILES,
} from "../src/main/pipeline/fontMatchingRuntimeAssets";
import {
  FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
  FONT_MATCHING_RUNTIME_MARKER_FILE,
  resolveFontMatchingArtifactDirSync,
} from "../src/main/pipeline/fontMatchingRuntimePaths";

const modelDownloadsMocks = vi.hoisted(() => ({
  ensureRemoteFile: vi.fn(),
}));

vi.mock("../src/main/runtimeSupport/modelDownloads", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/main/runtimeSupport/modelDownloads")
    >();
  return {
    ...actual,
    ensureRemoteFile: modelDownloadsMocks.ensureRemoteFile,
  };
});

beforeEach(() => {
  modelDownloadsMocks.ensureRemoteFile.mockReset();
  modelDownloadsMocks.ensureRemoteFile.mockImplementation(
    async (options: { modelDir: string; fileName: string }) =>
      join(options.modelDir, options.fileName),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `mgt-font-matching-${prefix}-`));
}

describe("resolveFontMatchingArtifactDirSync", () => {
  it("prefers the staged bundle in runtimeDir when the marker file is present (dev)", () => {
    const runtimeDir = createTempDir("runtime-staged");
    mkdirSync(join(runtimeDir, "font-matching"), { recursive: true });
    writeFileSync(
      join(runtimeDir, "font-matching", FONT_MATCHING_RUNTIME_MARKER_FILE),
      "{}",
    );
    const dataRoot = createTempDir("data");

    const dir = resolveFontMatchingArtifactDirSync({ runtimeDir, dataRoot });

    expect(dir).toBe(join(runtimeDir, "font-matching"));
    expect(modelDownloadsMocks.ensureRemoteFile).not.toHaveBeenCalled();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("falls back to the data-root cache when the marker is absent (packaged)", () => {
    const runtimeDir = createTempDir("runtime-empty");
    const dataRoot = createTempDir("data");

    const dir = resolveFontMatchingArtifactDirSync({ runtimeDir, dataRoot });

    expect(dir).toBe(
      join(
        dataRoot,
        "models",
        "font-matching",
        FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
      ),
    );
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });
});

describe("ensureFontMatchingRuntimeAssets", () => {
  it("downloads each of the 7 bundle files with the pinned digest and size into the cache dir", async () => {
    const dataRoot = createTempDir("data");
    const { ensureFontMatchingRuntimeAssets } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    const cacheDir = await ensureFontMatchingRuntimeAssets({ dataRoot });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(7);
    expect(cacheDir).toBe(
      join(
        dataRoot,
        "models",
        "font-matching",
        FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
      ),
    );
    FONT_MATCHING_RUNTIME_FILES.forEach((file, index) => {
      expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          modelDir: cacheDir,
          url: `${FONT_MATCHING_RUNTIME_BASE_URL}/${file.urlName ?? file.fileName}`,
          fileName: file.fileName,
          expectedSha256: file.sha256,
          minimumBytes: file.bytes,
          progressPhase: "font_matching_downloading",
        }),
      );
    });
    // GitHub Releases strips the marker's leading dot and prefixes `default.`,
    // so it downloads from the renamed asset but caches under the canonical
    // dot-name that resolveFontMatchingArtifactDirSync checks.
    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: `${FONT_MATCHING_RUNTIME_BASE_URL}/default.font-matching-runtime-artifact-owned.json`,
        fileName: FONT_MATCHING_RUNTIME_MARKER_FILE,
      }),
    );
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("forwards the abort signal and progress callback to each download", async () => {
    const dataRoot = createTempDir("data");
    const { ensureFontMatchingRuntimeAssets } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");
    const controller = new AbortController();
    const onProgress = vi.fn();

    await ensureFontMatchingRuntimeAssets({
      dataRoot,
      signal: controller.signal,
      onProgress,
    });

    for (let i = 1; i <= 7; i += 1) {
      expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
        i,
        expect.objectContaining({ signal: controller.signal, onProgress }),
      );
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });
});

describe("prepareFontMatchingRuntime", () => {
  it("is a no-op when the staged dev bundle marker is present", async () => {
    const runtimeDir = createTempDir("runtime-staged");
    mkdirSync(join(runtimeDir, "font-matching"), { recursive: true });
    writeFileSync(
      join(runtimeDir, "font-matching", FONT_MATCHING_RUNTIME_MARKER_FILE),
      "{}",
    );
    const dataRoot = createTempDir("data");
    const { prepareFontMatchingRuntime } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    await prepareFontMatchingRuntime({
      paths: { runtimeDir, dataRoot },
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(modelDownloadsMocks.ensureRemoteFile).not.toHaveBeenCalled();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("downloads the bundle into the cache when the marker is absent", async () => {
    const runtimeDir = createTempDir("runtime-empty");
    const dataRoot = createTempDir("data");
    const { prepareFontMatchingRuntime } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    await prepareFontMatchingRuntime({
      paths: { runtimeDir, dataRoot },
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(7);
    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
      7,
      expect.objectContaining({
        url: `${FONT_MATCHING_RUNTIME_BASE_URL}/encoder.onnx`,
        fileName: "encoder.onnx",
      }),
    );
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });
});
