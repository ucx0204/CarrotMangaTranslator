import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/main/pipeline/fontChapterC18Manifest.json";
import {
  prepareFontChapterRuntime,
  resolveFontChapterRuntimeManifest,
} from "../src/main/pipeline/fontChapterRuntimeAssets";

const download = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("network unavailable")),
);
vi.mock("../src/main/runtimeSupport/modelDownloads", () => ({
  ensureRemoteFile: download,
}));

describe("approved C23 runtime binding", () => {
  it("passes the actual release digest, cancellation and progress to the installer", async () => {
    const options = {
      paths: {
        dataRoot: resolve(tmpdir(), `fc23-${randomUUID()}`),
        runtimeDir: resolve("src/main/runtime"),
      },
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };
    await expect(prepareFontChapterRuntime(options)).rejects.toThrow(
      "network unavailable",
    );
    const resolved = resolveFontChapterRuntimeManifest();
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: resolved.url,
        expectedSha256: resolved.archive.sha256,
        expectedTotalBytes: resolved.archive.bytes,
        signal: options.signal,
        onProgress: options.onProgress,
      }),
    );
  });
  it("uses separate native dependencies while preserving the same trained models and algorithms", () => {
    const windows = resolveFontChapterRuntimeManifest("win32", "x64");
    const mac = resolveFontChapterRuntimeManifest("darwin", "arm64");
    expect(windows.manifest.runtimeSources).toEqual(manifest.runtimeSources);
    expect(mac.manifest.runtimeSources).toEqual(manifest.runtimeSources);
    const trained = manifest.files.filter(
      (row) => row.path !== "python-inventory.json",
    );
    for (const resolved of [windows, mac]) {
      expect(resolved.manifest.files.slice(0, trained.length)).toEqual(trained);
      expect(resolved.url).toContain("/font-chapter-c23-20260909-r2/");
      expect(resolved.archive.bytes).toBeGreaterThan(1_000_000);
      expect(resolved.manifest.assetDirectory).not.toBe(
        manifest.assetDirectory,
      );
    }
    expect(windows.manifest.files.at(-1)?.sha256).not.toBe(
      mac.manifest.files.at(-1)?.sha256,
    );
    expect(() => resolveFontChapterRuntimeManifest("linux", "x64")).toThrow(
      "Unsupported",
    );
  });
  it("binds every shipped algorithm and keeps a distinct rollback-safe asset root", () => {
    expect(manifest.version).toBe("c23.0");
    expect(manifest.assetDirectory).toBe("font-chapter-c18/c23-v1");
    const root = resolve("src/main/runtime/font-chapter-c18");
    expect(manifest.runtimeSources.map((row) => row.path).sort()).toEqual(
      readdirSync(root)
        .filter((name) => name.endsWith(".py"))
        .sort(),
    );
    for (const row of manifest.runtimeSources) {
      const bytes = readFileSync(resolve(root, row.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
    }
  });
});
