import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FONT_MATCHING_RUNTIME_BASE_URL,
  FONT_MATCHING_RUNTIME_FILES,
  FONT_MATCHING_RUNTIME_RELEASE_TAG,
} from "../src/main/pipeline/fontMatchingRuntimeAssets";
import {
  FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
  FONT_MATCHING_RUNTIME_MARKER_FILE,
  resolveFontMatchingArtifactDirSync,
} from "../src/main/pipeline/fontMatchingRuntimePaths";

const modelDownloadsMocks = vi.hoisted(() => ({
  ensureRemoteFile: vi.fn(),
}));
const bundledV2Dir = join(
  __dirname,
  "..",
  "src",
  "main",
  "runtime",
  "font-matching",
);

function stageBundledV2Files(runtimeDir: string): void {
  const destination = join(runtimeDir, "font-matching");
  mkdirSync(destination, { recursive: true });
  for (const file of FONT_MATCHING_RUNTIME_FILES.filter(
    (entry) => entry.source === "bundled-v2",
  )) {
    copyFileSync(
      join(bundledV2Dir, file.fileName),
      join(destination, file.fileName),
    );
  }
}

function stageCompleteDevBundle(runtimeDir: string): void {
  stageBundledV2Files(runtimeDir);
  const destination = join(runtimeDir, "font-matching");
  for (const file of FONT_MATCHING_RUNTIME_FILES.filter(
    (entry) => entry.source === "remote-v2-release",
  )) {
    // Path resolution only checks the complete seven-file inventory. Avoid
    // coupling this small unit test to ignored 467 MiB local artifacts.
    writeFileSync(join(destination, file.fileName), "fixture");
  }
}

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
  it("prefers only a complete staged bundle in runtimeDir (dev)", () => {
    const runtimeDir = createTempDir("runtime-staged");
    stageCompleteDevBundle(runtimeDir);
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
  it("pins every remote asset to the immutable v2 release tag", () => {
    expect(FONT_MATCHING_RUNTIME_RELEASE_TAG).toBe("font-matching-runtime-v2");
    expect(FONT_MATCHING_RUNTIME_BASE_URL).toBe(
      "https://github.com/ucx0204/CarrotMangaTranslator/releases/download/font-matching-runtime-v2",
    );
  });

  it("installs bundled v2 trust files and downloads only external large assets", async () => {
    const dataRoot = createTempDir("data");
    const { ensureFontMatchingRuntimeAssets } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    const cacheDir = await ensureFontMatchingRuntimeAssets({
      dataRoot,
      bundledDir: bundledV2Dir,
    });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(3);
    expect(cacheDir).toBe(
      join(
        dataRoot,
        "models",
        "font-matching",
        FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
      ),
    );
    FONT_MATCHING_RUNTIME_FILES.filter(
      (file) => file.source === "remote-v2-release",
    ).forEach((file, index) => {
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
    expect(existsSync(join(cacheDir, FONT_MATCHING_RUNTIME_MARKER_FILE))).toBe(
      true,
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
      bundledDir: bundledV2Dir,
      signal: controller.signal,
      onProgress,
    });

    for (let i = 1; i <= 3; i += 1) {
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
    stageCompleteDevBundle(runtimeDir);
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
    stageBundledV2Files(runtimeDir);
    const dataRoot = createTempDir("data");
    const { prepareFontMatchingRuntime } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    await prepareFontMatchingRuntime({
      paths: { runtimeDir, dataRoot },
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(3);
    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: `${FONT_MATCHING_RUNTIME_BASE_URL}/encoder.onnx`,
        fileName: "encoder.onnx",
      }),
    );
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });
});
