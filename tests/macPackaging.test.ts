import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");
const require = createRequire(import.meta.url);
const { MAC_RUNTIME_MANIFEST } =
  require("../scripts/mac-runtime-manifest.cjs") as {
    MAC_RUNTIME_MANIFEST: {
      platform: string;
      arch: string;
      minimumSystemVersion: string;
      python: { version: string; url: string; sha256: string };
      ocrPackages: readonly string[];
      llamaRuntimes: ReadonlyArray<{
        id: string;
        url: string;
        sha256: string;
      }>;
    };
  };
const { assertSafeArchiveEntry } =
  require("../scripts/prepare-mac-runtime.cjs") as {
    assertSafeArchiveEntry: (entryPath: string, linkPath?: string) => void;
  };

describe("Apple Silicon Alpha packaging", () => {
  it("pins Electron and every downloaded executable runtime", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(packageJson.devDependencies.electron).toBe("43.1.1");
    expect(packageJson.devDependencies["ffmpeg-static"]).toBe("5.3.0");
    expect(packageJson.dependencies.tar).toBe("^7.5.7");
    expect(packageJson.scripts["dist:mac:alpha"]).toBe(
      "node scripts/dist-mac-alpha.cjs",
    );
    expect(MAC_RUNTIME_MANIFEST).toMatchObject({
      platform: "darwin",
      arch: "arm64",
      minimumSystemVersion: "14.0",
      python: {
        version: "3.12.13",
        sha256:
          "5a30271f8d345a5b02b0c9e4e31e0f1e1455a8e4a04fba95cd9762472abc3b17",
      },
      ocrPackages: ["paddlepaddle==3.3.1", "paddleocr[doc-parser]==3.7.0"],
    });
    expect(MAC_RUNTIME_MANIFEST.llamaRuntimes).toEqual([
      expect.objectContaining({
        id: "llama-b9547-metal-arm64",
        sha256:
          "8791fdac4d5b7008b53fd15c609491d5a2fce2d180bb0b0e041eac53c5ade000",
      }),
      expect.objectContaining({
        id: "beellama-v0.3.1-metal-arm64",
        sha256:
          "14c0af87fc124e50469279ceae96016bbc6f7649de484b1de8a0a38675004556",
      }),
    ]);
    for (const manifest of [
      join(repoRoot, "tools", "mgt-koharu-inpaint-runner", "Cargo.toml"),
      join(repoRoot, "tools", "mgt-flux-klein-runner", "Cargo.toml"),
    ]) {
      expect(readFileSync(manifest, "utf8")).toContain(
        'rev = "0d640615d435a399bc195c892de8f5d17efb68f8"',
      );
    }
  });

  it("rejects archive traversal and escaping symlinks", () => {
    expect(() => assertSafeArchiveEntry("runtime/llama-server")).not.toThrow();
    expect(() =>
      assertSafeArchiveEntry("runtime/libcurrent.dylib", "libggml.dylib"),
    ).not.toThrow();
    expect(() => assertSafeArchiveEntry("../outside")).toThrow(
      "Unsafe archive entry",
    );
    expect(() => assertSafeArchiveEntry("/absolute/path")).toThrow(
      "Unsafe archive entry",
    );
    expect(() =>
      assertSafeArchiveEntry("runtime/link", "../../outside"),
    ).toThrow("escapes extraction root");
  });

  it("keeps Windows resources out of the arm64 app configuration", () => {
    const config = readFileSync(
      join(repoRoot, "electron-builder.config.cjs"),
      "utf8",
    );

    expect(config).toContain('minimumSystemVersion: "14.0"');
    expect(config).toContain('target: "dmg"');
    expect(config).toContain('target: "zip"');
    expect(config).toContain('arch: ["arm64"]');
    expect(config).toContain('executableName: "CarrotMangaTranslator"');
    expect(config).toContain("macExtraResources");
    expect(config).toContain("windowsExtraResources");
    expect(config).toContain("Windows binaries leaked into the macOS app");
    expect(config).toContain('identity: macDeveloperSigning ? undefined : "-"');
    expect(config).toContain("notarize: macDeveloperSigning");
  });

  it("runs real OCR and Metal inpainting package smokes in release CI", () => {
    const verifier = readFileSync(
      join(repoRoot, "scripts", "verify-mac-package.cjs"),
      "utf8",
    );
    const smokes = readFileSync(
      join(repoRoot, "scripts", "verify-mac-runtime-smokes.cjs"),
      "utf8",
    );

    expect(verifier).toContain("await verifyMacRuntimeSmokes({ appPath })");
    expect(smokes).toContain('ocrDevice: "cpu"');
    expect(smokes).toContain('ocrBboxMode: "ocr"');
    expect(smokes).toContain('"PP-OCRv6_tiny_det"');
    expect(smokes).toContain('"PP-OCRv6_tiny_rec"');
    expect(smokes).toContain('"aot-inpainting"');
    expect(smokes).toContain('"lama-manga"');
    expect(smokes).toContain('"metal-native"');
    expect(smokes).toContain("128 * 128");
    expect(verifier).toContain('MGT_MAC_PACKAGE_SMOKE_STAGE: "prepare"');
    expect(verifier).toContain('MGT_MAC_PACKAGE_SMOKE_STAGE: "verify"');
    const appSmoke = readFileSync(
      join(repoRoot, "src", "main", "macPackageSmoke.ts"),
      "utf8",
    );
    expect(appSmoke).toContain("await previewImages([sourcePath])");
    expect(appSmoke).toContain("await createImport({");
    expect(appSmoke).toContain("await savePageBlocks({");
    expect(appSmoke).toContain("await openChapter(prepared.chapterId)");
    expect(appSmoke).toContain("renderPageWithTranslationBlocksForExport");
  });

  it("pins the release workflow to the standard M1 runner and both signing modes", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "mac-alpha.yml"),
      "utf8",
    );
    const checks = readFileSync(
      join(repoRoot, ".github", "workflows", "check.yml"),
      "utf8",
    );

    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).not.toContain("macos-latest");
    expect(workflow).toContain("MAC_CSC_LINK");
    expect(workflow).toContain("APPLE_API_KEY_P8_B64");
    expect(workflow).toContain("MGT_MAC_SIGNING_MODE=adhoc");
    expect(workflow).toContain("MGT_MAC_SIGNING_MODE=developer-id");
    expect(workflow).toContain("--prerelease");
    expect(workflow).toContain("SHA256SUMS-mac-alpha.txt");
    expect(workflow).toContain("MAC_ALPHA_TEST_CHECKLIST.md");
    expect(workflow).toContain("mac-alpha-ui-1440x900.png");
    expect(workflow).toContain("mac-alpha-ui-1240x760.png");
    expect(checks).toContain("macos-arm64-check:");
    expect(checks).toContain("runs-on: macos-15");
  });
});
