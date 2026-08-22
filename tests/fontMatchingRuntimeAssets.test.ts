import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CROSS_SCRIPT_PROXY_RUNTIME_ASSETS,
  ensureCrossScriptProxyRuntimeAssets,
} from "../src/main/pipeline/fontMatchingCrossScriptProxyAssets";
import {
  CROSS_SCRIPT_PROXY_RUNTIME_VERSION,
  resolveCrossScriptProxyRuntimeDir,
} from "../src/main/pipeline/fontMatchingCrossScriptProxyPaths";
import {
  FONT_MATCHING_RUNTIME_BASE_URL,
  FONT_MATCHING_RUNTIME_FILES,
  FONT_MATCHING_RUNTIME_RELEASE_TAG,
  FONT_MATCHING_SHARED_BASE_URL,
  FONT_MATCHING_SHARED_RELEASE_TAG,
} from "../src/main/pipeline/fontMatchingRuntimeAssets";
import {
  FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
  resolveFontMatchingArtifactDirSync,
} from "../src/main/pipeline/fontMatchingRuntimePaths";

const modelDownloadsMocks = vi.hoisted(() => ({
  ensureRemoteFile: vi.fn(),
}));
const exactRuntimeMarker = Buffer.from(
  "ewogICJhcnRpZmFjdHMiOiB7CiAgICAiYXV0by1tYXRjaC1hY3RpdmUtY2F0YWxvZy5qc29uIjogIjU5ZjdlZDQ5ZTJjYTc1ZDUzN2EzZGQ0ZDkxYWZmNmQ4OTE3NWM4ODVjNDVjYThmMDZiMGIwZjc1NGFjNDU2NzYiLAogICAgImVuY29kZXIub25ueCI6ICI4YjlkYjZiYmUyNzI1MTBjZWRjMGY1Y2UzN2NlMGQxZDdmOTBjMTQ2YjdjNDJkZDA3Y2ExNGMyNmVmZjRhOTg1IiwKICAgICJwcm90b3R5cGUtZmVhdHVyZXMuZjMyIjogImNiNDQ3OWNkN2E0OGYwNTI2OTgyMzVmZDQyN2M3ZmQ5MGE5MWZiNGVjNDdlNzQzMTZiZDU3NGIxZmZkN2JjZDMiLAogICAgInJhbmtlci5vbm54IjogImUwNDlmYzc0YzNiYWVlZWU5YWJhMTc5NDEyYTNiMjAzODczMDRiNzQ5OTM2YzE2N2VjYzc1M2FmY2M3OGY0YWEiLAogICAgInJ1bnRpbWUtY29udHJhY3QuanNvbiI6ICJmMWVjNTk4MjQ3Zjg2OTA0MDcyYzA2MTVlYzM4ZjdlZmU0ZWFiMzk1MDI2ODIwNmNhZTVmYTllOWZmYzVmNTJhIiwKICAgICJzZWxlY3Rpb24tY2FsaWJyYXRpb24uanNvbiI6ICJhYWFhYTkzOGQ1ZmJlZDYwNzAxMTViMmQyMDZjNmNjNGEzNTUxN2IzYjExMDYxZmIwYTRkMTEzODNjYWE1NjYwIgogIH0sCiAgIm93bmVyIjogImNhcnJvdC1tYW5nYS10cmFuc2xhdG9yL2ZvbnQtbWF0Y2hpbmctcnVudGltZS1hcnRpZmFjdC12MiIsCiAgInNhZmVfcmVwbGFjZSI6IHRydWUsCiAgInNjaGVtYV92ZXJzaW9uIjogImZvbnQtbWF0Y2hpbmctcnVudGltZS1hcnRpZmFjdC12MiIKfQo=",
  "base64",
);
const originalLogPath = process.env.MANGA_TRANSLATOR_LOG_PATH;

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
  if (originalLogPath === undefined) {
    delete process.env.MANGA_TRANSLATOR_LOG_PATH;
  } else {
    process.env.MANGA_TRANSLATOR_LOG_PATH = originalLogPath;
  }
});

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), "mgt-font-matching-" + prefix + "-"));
}

function stageCompleteRuntime(runtimeDir: string): void {
  const destination = join(runtimeDir, "font-matching");
  mkdirSync(destination, { recursive: true });
  for (const file of FONT_MATCHING_RUNTIME_FILES) {
    writeFileSync(join(destination, file.fileName), "test fixture");
  }
}

function stageCompleteProxy(runtimeDir: string): void {
  const destination = join(runtimeDir, "font-matching-crossscript-proxy");
  mkdirSync(destination, { recursive: true });
  for (const file of CROSS_SCRIPT_PROXY_RUNTIME_ASSETS) {
    writeFileSync(join(destination, file.fileName), "test fixture");
  }
}

describe("font matching runtime paths", () => {
  it("uses complete development bundles and otherwise resolves writable caches", () => {
    const runtimeDir = createTempDir("runtime-paths");
    const dataRoot = createTempDir("data-paths");
    expect(resolveFontMatchingArtifactDirSync({ runtimeDir, dataRoot })).toBe(
      join(
        dataRoot,
        "models",
        "font-matching",
        FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
      ),
    );
    expect(resolveCrossScriptProxyRuntimeDir({ runtimeDir, dataRoot })).toBe(
      join(
        dataRoot,
        "models",
        "font-matching-crossscript-proxy",
        CROSS_SCRIPT_PROXY_RUNTIME_VERSION,
      ),
    );

    stageCompleteRuntime(runtimeDir);
    stageCompleteProxy(runtimeDir);
    expect(resolveFontMatchingArtifactDirSync({ runtimeDir, dataRoot })).toBe(
      join(runtimeDir, "font-matching"),
    );
    expect(resolveCrossScriptProxyRuntimeDir({ runtimeDir, dataRoot })).toBe(
      join(runtimeDir, "font-matching-crossscript-proxy"),
    );
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });
});

describe("font matching external releases", () => {
  it("pins the current and shared immutable release tags", () => {
    expect(FONT_MATCHING_RUNTIME_RELEASE_TAG).toBe(
      "font-matching-runtime-r33-proxy-20260822-r1",
    );
    expect(FONT_MATCHING_RUNTIME_BASE_URL).toBe(
      "https://github.com/ucx0204/CarrotMangaTranslator/releases/download/font-matching-runtime-r33-proxy-20260822-r1",
    );
    expect(FONT_MATCHING_SHARED_RELEASE_TAG).toBe("font-matching-runtime-v2");
    expect(FONT_MATCHING_SHARED_BASE_URL).toBe(
      "https://github.com/ucx0204/CarrotMangaTranslator/releases/download/font-matching-runtime-v2",
    );
  });

  it("downloads every R33 and shared runtime file instead of requiring bundled files", async () => {
    const dataRoot = createTempDir("data-runtime");
    const { ensureFontMatchingRuntimeAssets } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");
    const cacheDir = await ensureFontMatchingRuntimeAssets({ dataRoot });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(7);
    FONT_MATCHING_RUNTIME_FILES.forEach((file, index) => {
      const baseUrl =
        file.release === "r33"
          ? FONT_MATCHING_RUNTIME_BASE_URL
          : FONT_MATCHING_SHARED_BASE_URL;
      expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          modelDir: cacheDir,
          url: baseUrl + "/" + (file.urlName ?? file.fileName),
          fileName: file.fileName,
          expectedSha256: file.sha256,
          expectedTotalBytes: file.bytes,
          maximumBytes: file.bytes,
          progressPhase: "font_matching_downloading",
        }),
      );
    });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("migrates exact assets from the previous cache without redownloading them", async () => {
    const dataRoot = createTempDir("data-migrate");
    const sourceDir = join(
      dataRoot,
      "models",
      "font-matching",
      "active21-r5-e1-release-v1",
    );
    mkdirSync(sourceDir, { recursive: true });
    const marker = FONT_MATCHING_RUNTIME_FILES[0];
    writeFileSync(join(sourceDir, marker.fileName), exactRuntimeMarker);
    const { ensureFontMatchingRuntimeAssets } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    const cacheDir = await ensureFontMatchingRuntimeAssets({ dataRoot });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(6);
    expect(readFileSync(join(cacheDir, marker.fileName))).toEqual(
      exactRuntimeMarker,
    );
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("keeps an exact destination cache file and ignores an invalid old copy", async () => {
    const dataRoot = createTempDir("data-existing");
    const marker = FONT_MATCHING_RUNTIME_FILES[0];
    const cacheDir = join(
      dataRoot,
      "models",
      "font-matching",
      FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
    );
    const oldDir = join(
      dataRoot,
      "models",
      "font-matching",
      "active21-v8-r3h-manual-v2-release-v1",
    );
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(cacheDir, marker.fileName), exactRuntimeMarker);
    writeFileSync(join(oldDir, marker.fileName), "invalid");
    const { ensureFontMatchingRuntimeAssets } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    await ensureFontMatchingRuntimeAssets({ dataRoot });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(6);
    expect(existsSync(join(cacheDir, marker.fileName))).toBe(true);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("stops before downloading when already aborted", async () => {
    const dataRoot = createTempDir("data-aborted");
    const controller = new AbortController();
    controller.abort();
    const { ensureFontMatchingRuntimeAssets } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    await expect(
      ensureFontMatchingRuntimeAssets({
        dataRoot,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(modelDownloadsMocks.ensureRemoteFile).not.toHaveBeenCalled();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("downloads the complete cross-script proxy from the current release", async () => {
    const dataRoot = createTempDir("data-proxy");
    const cacheDir = await ensureCrossScriptProxyRuntimeAssets({ dataRoot });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(5);
    CROSS_SCRIPT_PROXY_RUNTIME_ASSETS.forEach((file, index) => {
      expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          modelDir: cacheDir,
          url: FONT_MATCHING_RUNTIME_BASE_URL + "/" + file.urlName,
          fileName: file.fileName,
          expectedSha256: file.sha256,
          expectedTotalBytes: file.bytes,
          maximumBytes: file.bytes,
        }),
      );
    });
    rmSync(dataRoot, { recursive: true, force: true });
  });
});

describe("prepareFontMatchingRuntime", () => {
  it("does not download when both complete development bundles exist", async () => {
    const runtimeDir = createTempDir("runtime-complete");
    const dataRoot = createTempDir("data-complete");
    stageCompleteRuntime(runtimeDir);
    stageCompleteProxy(runtimeDir);
    const { prepareFontMatchingRuntime } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    await prepareFontMatchingRuntime({ paths: { runtimeDir, dataRoot } });

    expect(modelDownloadsMocks.ensureRemoteFile).not.toHaveBeenCalled();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("downloads all twelve external files for an empty packaged runtime", async () => {
    const runtimeDir = createTempDir("runtime-empty");
    const dataRoot = createTempDir("data-empty");
    const { prepareFontMatchingRuntime } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");
    const controller = new AbortController();
    const onProgress = vi.fn();

    await prepareFontMatchingRuntime({
      paths: { runtimeDir, dataRoot },
      signal: controller.signal,
      onProgress,
    });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(12);
    for (let index = 1; index <= 12; index += 1) {
      expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
        index,
        expect.objectContaining({ signal: controller.signal, onProgress }),
      );
    }
    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url:
          FONT_MATCHING_RUNTIME_BASE_URL +
          "/font-matching-crossscript-proxy-candidate-glyphs.u8",
        fileName: "candidate-glyphs.u8",
      }),
    );
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("downloads only the missing proxy when the development ranker bundle is complete", async () => {
    const runtimeDir = createTempDir("runtime-proxy-missing");
    const dataRoot = createTempDir("data-proxy-missing");
    stageCompleteRuntime(runtimeDir);
    const { prepareFontMatchingRuntime } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    await prepareFontMatchingRuntime({ paths: { runtimeDir, dataRoot } });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(5);
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("downloads only the missing ranker when the development proxy is complete", async () => {
    const runtimeDir = createTempDir("runtime-ranker-missing");
    const dataRoot = createTempDir("data-ranker-missing");
    stageCompleteProxy(runtimeDir);
    const { prepareFontMatchingRuntime } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");

    await prepareFontMatchingRuntime({ paths: { runtimeDir, dataRoot } });

    expect(modelDownloadsMocks.ensureRemoteFile).toHaveBeenCalledTimes(7);
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });
});

describe("prepareFontMatchingRuntimeForRun", () => {
  it("does nothing when auto matching is disabled or dependencies are injected", async () => {
    const paths = {
      runtimeDir: createTempDir("runtime-run-skip"),
      dataRoot: createTempDir("data-run-skip"),
    };
    const { prepareFontMatchingRuntimeForRun } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");
    const emit = vi.fn();
    const signal = new AbortController().signal;

    await prepareFontMatchingRuntimeForRun(
      { autoFontMatching: false, emit, jobId: "skip-disabled", signal },
      paths,
      false,
    );
    await prepareFontMatchingRuntimeForRun(
      { autoFontMatching: true, emit, jobId: "skip-injected", signal },
      paths,
      true,
    );

    expect(modelDownloadsMocks.ensureRemoteFile).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    rmSync(paths.runtimeDir, { recursive: true, force: true });
    rmSync(paths.dataRoot, { recursive: true, force: true });
  });

  it("projects download progress into the pipeline job", async () => {
    const paths = {
      runtimeDir: createTempDir("runtime-run-progress"),
      dataRoot: createTempDir("data-run-progress"),
    };
    const progress = {
      progressText: "폰트 다운로드",
      progressMode: "determinate" as const,
      progressPercent: 0.5,
      progressBytes: 5,
      progressTotalBytes: 10,
      detail: "detail",
      installLogLine: "log",
    };
    modelDownloadsMocks.ensureRemoteFile.mockImplementation(
      async (options: {
        modelDir: string;
        fileName: string;
        onProgress?: (value: typeof progress) => void;
      }) => {
        options.onProgress?.(progress);
        return join(options.modelDir, options.fileName);
      },
    );
    const { prepareFontMatchingRuntimeForRun } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");
    const emit = vi.fn();

    await prepareFontMatchingRuntimeForRun(
      {
        autoFontMatching: true,
        emit,
        jobId: "font-download",
        signal: new AbortController().signal,
      },
      paths,
      false,
    );

    expect(emit).toHaveBeenCalledWith({
      id: "font-download",
      kind: "gemma-analysis",
      status: "starting",
      phase: "font_matching_downloading",
      ...progress,
    });
    rmSync(paths.runtimeDir, { recursive: true, force: true });
    rmSync(paths.dataRoot, { recursive: true, force: true });
  });

  it("degrades on a download failure but propagates cancellation", async () => {
    const paths = {
      runtimeDir: createTempDir("runtime-run-failure"),
      dataRoot: createTempDir("data-run-failure"),
    };
    const { prepareFontMatchingRuntimeForRun } =
      await import("../src/main/pipeline/fontMatchingRuntimeAssets");
    const emit = vi.fn();
    const active = new AbortController();
    process.env.MANGA_TRANSLATOR_LOG_PATH = join(paths.dataRoot, "test.log");
    modelDownloadsMocks.ensureRemoteFile.mockRejectedValueOnce(
      new Error("download failed"),
    );

    await expect(
      prepareFontMatchingRuntimeForRun(
        {
          autoFontMatching: true,
          emit,
          jobId: "download-failed",
          signal: active.signal,
        },
        paths,
        false,
      ),
    ).resolves.toBeUndefined();

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      prepareFontMatchingRuntimeForRun(
        {
          autoFontMatching: true,
          emit,
          jobId: "download-aborted",
          signal: aborted.signal,
        },
        paths,
        false,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    rmSync(paths.runtimeDir, { recursive: true, force: true });
    rmSync(paths.dataRoot, { recursive: true, force: true });
  });
});
