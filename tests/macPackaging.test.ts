import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
const {
  assertSafeArchiveEntry,
  classifyMachODescription,
  copyMacRuntimePayload,
  removeWindowsRuntimeFiles,
} = require("../scripts/prepare-mac-runtime.cjs") as {
  assertSafeArchiveEntry: (entryPath: string, linkPath?: string) => void;
  classifyMachODescription: (
    description: string,
  ) => "other" | "arm64" | "universal-arm64" | "unsupported";
  copyMacRuntimePayload: (
    runtimeSource: string,
    runtimeTarget: string,
  ) => Promise<void>;
  removeWindowsRuntimeFiles: (currentDir: string) => Promise<string[]>;
};
const {
  configureElectronBuilderSigningEnvironment,
  configureMacBuildChannel,
  resolveMacBuildChannel,
} = require("../scripts/dist-mac-alpha.cjs") as {
  configureElectronBuilderSigningEnvironment: (
    environment: NodeJS.ProcessEnv,
  ) => void;
  configureMacBuildChannel: (
    channel: "stable" | "mac-alpha",
    environment: NodeJS.ProcessEnv,
  ) => void;
  resolveMacBuildChannel: (args: string[]) => "stable" | "mac-alpha";
};
const {
  assertElectronFrameworkExecutable,
  assertElectronHelperExecutables,
  requiresOtoolAlias,
  resolveMacChecksumFileName,
  resolveMacPackageChannel,
  shouldAllowHostedGuiSmokeFailure,
} = require("../scripts/verify-mac-package.cjs") as {
  assertElectronFrameworkExecutable: (appPath: string) => void;
  assertElectronHelperExecutables: (appPath: string) => void;
  requiresOtoolAlias: (filePath: string) => boolean;
  resolveMacChecksumFileName: (
    environment: NodeJS.ProcessEnv,
  ) => "SHA256SUMS-macOS-arm64.txt" | "SHA256SUMS-mac-alpha.txt";
  resolveMacPackageChannel: (
    environment: NodeJS.ProcessEnv,
  ) => "stable" | "mac-alpha";
  shouldAllowHostedGuiSmokeFailure: (
    input: {
      stage: "copy" | "prepare" | "verify";
      markerExists: boolean;
      message: string;
      smokeStartedAtMs: number;
      crashReport: {
        path: string;
        mtimeMs: number;
        procPath: string;
        exceptionType: string;
        signal: string;
        faultingThread: number;
        triggered: boolean;
        threadName: string;
      } | null;
    },
    environment: NodeJS.ProcessEnv,
  ) => boolean;
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
    expect(packageJson.scripts["dist:mac"]).toBe(
      "node scripts/dist-mac-alpha.cjs --stable",
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
    const runtimePreparer = readFileSync(
      join(repoRoot, "scripts", "prepare-mac-runtime.cjs"),
      "utf8",
    );
    expect(runtimePreparer).toContain(
      "await copyMacRuntimePayload(installRoot, pythonTarget)",
    );
    expect(runtimePreparer).toContain("await assertNoSymlinks(stagingTools)");
    expect(runtimePreparer).toContain(
      "await thinUniversalMachOFiles(pythonTarget)",
    );
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

  it.skipIf(process.platform === "win32")(
    "materializes llama dylib symlinks whose target is outside the binary folder",
    async () => {
      const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-llama-runtime-"));
      try {
        const sourceDir = join(runtimeDir, "bin");
        const libraryDir = join(runtimeDir, "lib");
        const targetDir = join(runtimeDir, "staged");
        mkdirSync(sourceDir, { recursive: true });
        mkdirSync(libraryDir, { recursive: true });
        writeFileSync(join(sourceDir, "llama-server"), "server");
        writeFileSync(join(libraryDir, "libggml-base.0.dylib"), "metal dylib");
        symlinkSync(
          "../lib/libggml-base.0.dylib",
          join(sourceDir, "libggml-base.dylib"),
        );

        await copyMacRuntimePayload(sourceDir, targetDir);

        const stagedDylib = join(targetDir, "libggml-base.dylib");
        expect(lstatSync(stagedDylib).isFile()).toBe(true);
        expect(lstatSync(stagedDylib).isSymbolicLink()).toBe(false);
        expect(readFileSync(stagedDylib, "utf8")).toBe("metal dylib");
      } finally {
        rmSync(runtimeDir, { recursive: true, force: true });
      }
    },
  );

  it("removes Windows-only launchers from the bundled macOS Python runtime", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-mac-python-runtime-"));
    try {
      const packageDir = join(runtimeDir, "lib", "site-packages", "distlib");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "t64.exe"), "windows launcher");
      writeFileSync(join(packageDir, "native.dll"), "windows library");
      writeFileSync(join(packageDir, "native.so"), "mac extension");

      const removed = await removeWindowsRuntimeFiles(runtimeDir);

      expect(removed.map((filePath) => basename(filePath)).sort()).toEqual([
        "native.dll",
        "t64.exe",
      ]);
      expect(existsSync(join(packageDir, "native.so"))).toBe(true);
      expect(existsSync(join(packageDir, "t64.exe"))).toBe(false);
      expect(existsSync(join(packageDir, "native.dll"))).toBe(false);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("classifies universal Python extensions for arm64 thinning", () => {
    expect(
      classifyMachODescription(
        "Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit bundle x86_64] [arm64:Mach-O 64-bit bundle arm64]",
      ),
    ).toBe("universal-arm64");
    expect(
      classifyMachODescription(
        "Mach-O 64-bit dynamically linked shared library arm64",
      ),
    ).toBe("arm64");
    expect(classifyMachODescription("Mach-O 64-bit bundle x86_64")).toBe(
      "unsupported",
    );
    expect(classifyMachODescription("POSIX shell script text executable")).toBe(
      "other",
    );
  });

  it("removes empty certificate variables before an ad-hoc build", () => {
    const environment: NodeJS.ProcessEnv = {
      MGT_MAC_SIGNING_MODE: "adhoc",
      CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
    };

    configureElectronBuilderSigningEnvironment(environment);

    expect(environment.CSC_LINK).toBeUndefined();
    expect(environment.CSC_KEY_PASSWORD).toBeUndefined();
    expect(environment.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
  });

  it("preserves Developer ID certificate variables", () => {
    const environment: NodeJS.ProcessEnv = {
      MGT_MAC_SIGNING_MODE: "developer-id",
      CSC_LINK: "developer-id-certificate",
      CSC_KEY_PASSWORD: "certificate-password",
    };

    configureElectronBuilderSigningEnvironment(environment);

    expect(environment.CSC_LINK).toBe("developer-id-certificate");
    expect(environment.CSC_KEY_PASSWORD).toBe("certificate-password");
    expect(environment.CSC_IDENTITY_AUTO_DISCOVERY).toBe("true");
  });

  it("selects stable packaging only with the explicit flag and bakes both channel variables", () => {
    expect(resolveMacBuildChannel([])).toBe("mac-alpha");
    expect(resolveMacBuildChannel(["--stable"])).toBe("stable");
    expect(() => resolveMacBuildChannel(["--unknown"])).toThrow(
      "Unsupported macOS packaging arguments",
    );

    const environment: NodeJS.ProcessEnv = {};
    configureMacBuildChannel("stable", environment);
    expect(environment.MGT_RELEASE_CHANNEL).toBe("stable");
    expect(environment.MANGA_TRANSLATOR_BUILD_CHANNEL).toBe("stable");
    expect(resolveMacChecksumFileName(environment)).toBe(
      "SHA256SUMS-macOS-arm64.txt",
    );
    expect(resolveMacPackageChannel(environment)).toBe("stable");
    expect(
      resolveMacChecksumFileName({ MGT_RELEASE_CHANNEL: "mac-alpha" }),
    ).toBe("SHA256SUMS-mac-alpha.txt");
  });

  it("aliases parenthesized Electron Helper paths before otool inspection", () => {
    expect(
      requiresOtoolAlias(
        "/Applications/App.app/Contents/Frameworks/App Helper (GPU).app/Contents/MacOS/App Helper (GPU)",
      ),
    ).toBe(true);
    expect(
      requiresOtoolAlias(
        "/Applications/App.app/Contents/MacOS/CarrotMangaTranslator",
      ),
    ).toBe(false);

    const verifier = readFileSync(
      join(repoRoot, "scripts", "verify-mac-package.cjs"),
      "utf8",
    );
    expect(verifier).toContain('mkdtempSync(join(tmpdir(), "mgt-otool-"))');
    expect(verifier).toContain("runOtool(filePath)");
    expect(
      readFileSync(join(repoRoot, "scripts", "dist-mac-alpha.cjs"), "utf8"),
    ).toContain("process.exit(1)");
  });

  it("rejects a final app whose Electron Framework executable is missing", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "mgt-final-app-"));
    try {
      const frameworkRoot = join(
        appRoot,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Versions",
        "A",
      );
      mkdirSync(frameworkRoot, { recursive: true });

      expect(() => assertElectronFrameworkExecutable(appRoot)).toThrow(
        "missing the Electron Framework executable",
      );

      writeFileSync(join(frameworkRoot, "Electron Framework"), "electron");
      expect(() => assertElectronFrameworkExecutable(appRoot)).not.toThrow();
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it("requires ASCII Electron Helper bundle and executable names", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "mgt-helper-app-"));
    const helperSuffixes = [
      "Helper",
      "Helper (GPU)",
      "Helper (Plugin)",
      "Helper (Renderer)",
    ];
    try {
      expect(() => assertElectronHelperExecutables(appRoot)).toThrow(
        "missing the ASCII Electron Helper executable",
      );

      for (const suffix of helperSuffixes) {
        const helperName = `CarrotMangaTranslator ${suffix}`;
        const executableDir = join(
          appRoot,
          "Contents",
          "Frameworks",
          `${helperName}.app`,
          "Contents",
          "MacOS",
        );
        mkdirSync(executableDir, { recursive: true });
        writeFileSync(join(executableDir, helperName), "helper");
      }

      expect(() => assertElectronHelperExecutables(appRoot)).not.toThrow();
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it("waives only the exact fresh GitHub-hosted pre-ready Electron trap", () => {
    const environment: NodeJS.ProcessEnv = {
      MGT_MAC_ALPHA_ALLOW_HOSTED_APP_SMOKE_TRAP:
        "macos15-electron43-crbrowsermain-v1",
      MGT_MAC_ALPHA_RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64",
      GITHUB_REF: "refs/heads/master",
      GITHUB_WORKFLOW_REF:
        "ucx0204/CarrotMangaTranslator/.github/workflows/mac-alpha.yml@refs/heads/master",
    };
    const input = {
      stage: "prepare" as const,
      markerExists: false,
      message: "Timed out waiting for packaged app smoke stage prepared",
      smokeStartedAtMs: 10_000,
      crashReport: {
        path: "/Users/runner/Library/Logs/DiagnosticReports/smoke.ips",
        mtimeMs: 12_000,
        procPath:
          "/Applications/CarrotMangaTranslatorAlphaSmoke.app/Contents/MacOS/CarrotMangaTranslator",
        exceptionType: "EXC_BREAKPOINT",
        signal: "SIGTRAP",
        faultingThread: 0,
        triggered: true,
        threadName: "CrBrowserMain",
      },
    };

    expect(shouldAllowHostedGuiSmokeFailure(input, environment)).toBe(true);
    expect(
      shouldAllowHostedGuiSmokeFailure(
        { ...input, stage: "verify" },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldAllowHostedGuiSmokeFailure(
        { ...input, markerExists: true },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldAllowHostedGuiSmokeFailure(
        {
          ...input,
          crashReport: { ...input.crashReport, signal: "SIGABRT" },
        },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldAllowHostedGuiSmokeFailure(input, {
        ...environment,
        MGT_MAC_ALPHA_RUNNER_ENVIRONMENT: "self-hosted",
      }),
    ).toBe(false);
    expect(
      shouldAllowHostedGuiSmokeFailure(
        {
          ...input,
          crashReport: { ...input.crashReport, mtimeMs: 1_000 },
        },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldAllowHostedGuiSmokeFailure(input, {
        ...environment,
        GITHUB_WORKFLOW_REF:
          "ucx0204/CarrotMangaTranslator/.github/workflows/check.yml@refs/heads/master",
      }),
    ).toBe(false);
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
    expect(config).toContain(
      'const productName = isMacBuild ? "CarrotMangaTranslator" : "당근망가번역기"',
    );
    expect(config).toContain('CFBundleDisplayName: "당근망가번역기"');
    expect(config).toContain('size: "3g"');
    expect(config).toContain("macExtraResources");
    expect(config).toContain("windowsExtraResources");
    expect(config).toContain("Windows binaries leaked into the macOS app");
    expect(config).toContain('identity: macDeveloperSigning ? undefined : "-"');
    expect(config).toContain("notarize: macDeveloperSigning");
    expect(config).toContain("extraMetadata");
    expect(config).toContain("buildChannel: isMacBuild ? macBuildChannel");
    expect(config).toContain(
      '"CarrotMangaTranslator-${version}-macOS-arm64.${ext}"',
    );
    expect(config).toContain(
      '"CarrotMangaTranslator-${version}-macOS-arm64-alpha.${ext}"',
    );
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
    expect(verifier).toContain("verifyPackagedBuildChannel(appPath)");
    expect(verifier).toContain("metadata.buildChannel");
    expect(verifier.match(/^\s+verifySigning\(appPath\);$/gm)).toHaveLength(4);
    expect(verifier).toContain('PYTHONDONTWRITEBYTECODE: "1"');
    expect(smokes).toContain('PYTHONDONTWRITEBYTECODE: "1"');
    expect(smokes).toContain('PYTHONPYCACHEPREFIX: join(workRoot, "pycache")');
    expect(smokes).toContain('ocrDevice: "cpu"');
    expect(smokes).toContain('ocrBboxMode: "ocr"');
    expect(smokes).toContain('"PP-OCRv6_tiny_det"');
    expect(smokes).toContain('"PP-OCRv6_tiny_rec"');
    expect(smokes).toContain('"aot-inpainting"');
    expect(smokes).toContain('"lama-manga"');
    expect(smokes).toContain('"metal-native"');
    expect(smokes).toContain("128 * 128");
    expect(verifier).toContain("--mgt-mac-package-smoke-stage=${stage}");
    expect(verifier).toContain('runApplicationSmoke(smokeApp, "prepare")');
    expect(verifier).toContain('runApplicationSmoke(smokeApp, "verify")');
    expect(verifier).toContain('"open",');
    expect(verifier).toContain('"-W",');
    expect(verifier).toContain('"--args",');
    expect(verifier).toContain('"--mgt-mac-package-smoke=alpha-ci-v1"');
    expect(verifier).toContain('"--disable-gpu"');
    expect(verifier).toContain("waitForSmokeMarker");
    expect(verifier).toContain("collectApplicationSmokeDiagnostics");
    expect(verifier).toContain("shouldAllowHostedGuiSmokeFailure");
    expect(verifier).toContain("findFreshApplicationCrashReport");
    expect(verifier).toContain("mac-alpha-hosted-app-smoke-waiver.json");
    expect(verifier).toContain("EXC_BREAKPOINT");
    expect(verifier).toContain("CrBrowserMain");
    expect(verifier).toContain('"bootstrap log"');
    expect(verifier).toContain("contents.slice(0, 20 * 1024)");
    expect(verifier).toContain("result.signal");
    expect(verifier).toContain('"--entitlements",');
    expect(verifier).toContain('"attach",');
    expect(verifier).toContain('"-readonly",');
    expect(verifier).toContain('findSingleAppBundle(mountRoot, "final DMG")');
    expect(verifier).toContain("verifyApplicationDirectorySmoke(appPath)");
    expect(verifier).toContain('"-x", "-k", zipPath, extractRoot');
    expect(verifier).toContain("verifyFinalDiskImage(dmgFiles[0])");
    expect(verifier).toContain("verifyFinalZipArchive(zipFiles[0])");
    const appSmoke = readFileSync(
      join(repoRoot, "src", "main", "macPackageSmoke.ts"),
      "utf8",
    );
    expect(appSmoke).toContain("MAC_PACKAGE_SMOKE_CLI_TOKEN");
    expect(appSmoke).toContain("readPackageSmokeStageArgument");
    expect(appSmoke).toContain("await previewImages([sourcePath])");
    expect(appSmoke).toContain("await createImport({");
    expect(appSmoke).toContain("await savePageBlocks({");
    expect(appSmoke).toContain("await openChapter(prepared.chapterId)");
    expect(appSmoke).toContain("renderPageWithTranslationBlocksForExport");
    expect(appSmoke).toContain("SMOKE_SOURCE_PNG");
    expect(appSmoke).not.toContain("createFromBitmap");
    expect(appSmoke).toContain('"export-page"');
    expect(appSmoke).toContain("writeSmokeMarker");
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
    expect(workflow).toContain(
      "MGT_MAC_ALPHA_ALLOW_HOSTED_APP_SMOKE_TRAP: macos15-electron43-crbrowsermain-v1",
    );
    expect(workflow).toContain(
      "MGT_MAC_ALPHA_RUNNER_ENVIRONMENT: ${{ runner.environment }}",
    );
    expect(workflow).toContain("--prerelease");
    expect(workflow).toContain("SHA256SUMS-mac-alpha.txt");
    expect(workflow).toContain("Confirm release artifacts");
    expect(workflow).toContain("MAC_ALPHA_TEST_CHECKLIST.md");
    expect(workflow).toContain("mac-alpha-ui-1440x900.png");
    expect(workflow).toContain("mac-alpha-ui-1240x760.png");
    expect(checks).toContain("macos-arm64-check:");
    expect(checks).toContain("runs-on: macos-15");
  });

  it("strictly verifies stable macOS artifacts before attaching them to the existing release", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "mac-release.yml"),
      "utf8",
    );

    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("npm run verify:hf-assets");
    expect(workflow).toContain("npm run dist:mac");
    expect(workflow).toContain("MGT_MAC_SIGNING_MODE=adhoc");
    expect(workflow).toContain("MGT_MAC_SIGNING_MODE=developer-id");
    expect(workflow).toContain(
      "CarrotMangaTranslator-${version}-macOS-arm64.dmg",
    );
    expect(workflow).toContain(
      "CarrotMangaTranslator-${version}-macOS-arm64.zip",
    );
    expect(workflow).toContain("SHA256SUMS-macOS-arm64.txt");
    expect(workflow).toContain("shasum -a 256 -c");
    expect(workflow).toContain(
      "CarrotMangaTranslator-Setup-${INPUT_TAG_NAME}.exe",
    );
    expect(workflow).toContain("--build-channel stable");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("--clobber");
    expect(workflow).toContain(
      "test ! -e dist/mac-alpha-hosted-app-smoke-waiver.json",
    );
    expect(workflow).not.toContain("MGT_MAC_ALPHA_ALLOW_HOSTED_APP_SMOKE_TRAP");
  });

  it("keeps the stable macOS Help menu out of the Alpha issue flow", () => {
    const integration = readFileSync(
      join(repoRoot, "src", "main", "macIntegration.ts"),
      "utf8",
    );

    expect(integration).toContain("const alpha = isAppleSiliconAlpha()");
    expect(integration).toContain("resolveMacIssueMenuTarget(alpha)");
    expect(integration).toContain("issueMenuTarget.labelKey");
    expect(integration).toContain("issueMenuTarget.url");
  });
});
