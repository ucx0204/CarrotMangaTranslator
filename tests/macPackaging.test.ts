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
  runMacBuildCli,
} = require("../scripts/dist-mac-alpha.cjs") as {
  configureElectronBuilderSigningEnvironment: (
    environment: NodeJS.ProcessEnv,
  ) => void;
  configureMacBuildChannel: (
    channel: "stable" | "mac-alpha",
    environment: NodeJS.ProcessEnv,
  ) => void;
  resolveMacBuildChannel: (args: string[]) => "stable" | "mac-alpha";
  runMacBuildCli: (
    build: () => Promise<void>,
    runtime: {
      reportError: (error: unknown) => void;
      exit: (code: number) => void;
    },
  ) => Promise<void>;
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
const {
  KOHARU_SMOKE_ASSETS,
  buildSmokePythonEnv,
  createKoharuSmokeRequest,
  createOcrSmokeRequest,
} = require("../scripts/verify-mac-runtime-smokes.cjs") as {
  KOHARU_SMOKE_ASSETS: ReadonlyArray<{ model: string }>;
  buildSmokePythonEnv: (workRoot: string) => NodeJS.ProcessEnv;
  createKoharuSmokeRequest: (
    model: string,
    images: { input: string; mask: string; bubble: string },
    output: string,
  ) => Record<string, unknown>;
  createOcrSmokeRequest: (
    imagePath: string,
    toolsDir: string,
    workRoot: string,
  ) => Record<string, unknown>;
};
const {
  assertPreparedSmoke,
  assertVerifiedSmoke,
  createApplicationSmokeLaunch,
  createDiagnosticExcerpt,
} = require("../scripts/mac-package-verification/app-smoke.cjs") as {
  assertPreparedSmoke: (result: Record<string, unknown>) => void;
  assertVerifiedSmoke: (result: Record<string, unknown>) => void;
  createApplicationSmokeLaunch: (
    appPath: string,
    stage: "prepare" | "verify",
  ) => {
    command: string;
    args: string[];
    options: { timeout: number };
  };
  createDiagnosticExcerpt: (contents: string) => string;
};
const { createDiskImageAttachCommand, createZipExtractCommand } =
  require("../scripts/mac-package-verification/artifacts.cjs") as {
    createDiskImageAttachCommand: (
      diskImagePath: string,
      mountRoot: string,
    ) => {
      command: string;
      args: string[];
      options: { timeout: number };
    };
    createZipExtractCommand: (
      zipPath: string,
      extractRoot: string,
    ) => {
      command: string;
      args: string[];
      options: { timeout: number };
    };
  };
const { resolveMacArtifactSet, verifyUnpackedApplication } =
  require("../scripts/mac-package-verification/runner.cjs") as {
    resolveMacArtifactSet: (files: string[]) => {
      diskImage: string;
      zipArchive: string;
    };
    verifyUnpackedApplication: (
      appPath: string,
      verification: {
        assertFramework: (appPath: string) => void;
        assertHelpers: (appPath: string) => void;
        verifyNative: (appPath: string) => unknown;
        verifyChannel: (appPath: string) => void;
        verifySignature: (appPath: string) => void;
        verifyTar: (appPath: string) => void;
        verifyApplicationSmoke: (appPath: string) => void;
        verifyRuntimes: (appPath: string) => void;
        verifyRuntimeSmokes: (options: { appPath: string }) => Promise<void>;
      },
    ) => Promise<void>;
  };

type ElectronBuilderMacConfig = {
  productName: string;
  extraMetadata: { buildChannel: string };
  extraResources: Array<{ from: string; to: string }>;
  mac: {
    target: Array<{ target: string; arch: string[] }>;
    minimumSystemVersion: string;
    executableName: string;
    extendInfo: { CFBundleDisplayName: string };
    artifactName: string;
    identity?: string;
    notarize: boolean;
    extraResources: Array<{ from: string; to: string }>;
  };
  dmg: { size: string; sign: boolean };
  win: { extraResources: Array<{ from: string; to: string }> };
  beforePack: (context: { electronPlatformName: string }) => void;
  afterPack: (context: {
    electronPlatformName: string;
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }) => Promise<void>;
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
  });

  it("reports a macOS build failure and exits unsuccessfully", async () => {
    const failure = new Error("packaging failed");
    const reported: unknown[] = [];
    const exitCodes: number[] = [];

    await runMacBuildCli(() => Promise.reject(failure), {
      reportError: (error) => reported.push(error),
      exit: (code) => exitCodes.push(code),
    });

    expect(reported).toEqual([failure]);
    expect(exitCodes).toEqual([1]);
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

  it("keeps Windows resources out of the arm64 app configuration", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-mac-config-"));
    try {
      const alphaConfig = loadMacBuilderConfig(
        temporaryRoot,
        "mac-alpha",
        "adhoc",
      );
      expect(() =>
        alphaConfig.beforePack({ electronPlatformName: "darwin" }),
      ).toThrow("Missing staged Apple Silicon runtime");
      expect(() =>
        alphaConfig.beforePack({ electronPlatformName: "win32" }),
      ).not.toThrow();

      mkdirSync(join(temporaryRoot, "tools"), { recursive: true });
      expect(() =>
        alphaConfig.beforePack({ electronPlatformName: "darwin" }),
      ).not.toThrow();

      const stableConfig = loadMacBuilderConfig(
        temporaryRoot,
        "stable",
        "developer-id",
      );

      expect(alphaConfig).toMatchObject({
        productName: "CarrotMangaTranslator",
        extraMetadata: { buildChannel: "mac-alpha" },
        mac: {
          target: [
            { target: "dmg", arch: ["arm64"] },
            { target: "zip", arch: ["arm64"] },
          ],
          minimumSystemVersion: "14.0",
          executableName: "CarrotMangaTranslator",
          extendInfo: { CFBundleDisplayName: "당근망가번역기" },
          artifactName:
            "CarrotMangaTranslator-${version}-macOS-arm64-alpha.${ext}",
          identity: "-",
          notarize: false,
        },
        dmg: { size: "3g", sign: false },
      });
      expect(alphaConfig.mac.extraResources).toEqual([
        {
          from: join(temporaryRoot, "tools"),
          to: "tools",
        },
      ]);
      expect(alphaConfig.mac.extraResources).not.toEqual(
        alphaConfig.win.extraResources,
      );
      expect(stableConfig).toMatchObject({
        extraMetadata: { buildChannel: "stable" },
        mac: {
          artifactName: "CarrotMangaTranslator-${version}-macOS-arm64.${ext}",
          notarize: true,
        },
        dmg: { sign: true },
      });
      expect(stableConfig.mac.identity).toBeUndefined();

      const appOutDir = join(temporaryRoot, "packaged");
      const resourcesDir = join(
        appOutDir,
        "CarrotMangaTranslator.app",
        "Contents",
        "Resources",
      );
      mkdirSync(resourcesDir, { recursive: true });
      writeFileSync(join(resourcesDir, "windows.dll"), "not allowed");
      await expect(
        alphaConfig.afterPack({
          electronPlatformName: "darwin",
          appOutDir,
          packager: {
            appInfo: { productFilename: "CarrotMangaTranslator" },
          },
        }),
      ).rejects.toThrow("Windows binaries leaked into the macOS app");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("builds concrete OCR, Metal, and packaged-app smoke requests", () => {
    const workRoot = join("work", "smoke");
    expect(buildSmokePythonEnv(workRoot)).toMatchObject({
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPYCACHEPREFIX: join(workRoot, "pycache"),
      PADDLE_PDX_CACHE_HOME: join(workRoot, "paddlex-cache"),
    });
    expect(createOcrSmokeRequest("input.png", "tools", workRoot)).toMatchObject(
      {
        imagePath: "input.png",
        toolsDir: "tools",
        ocrRuntimeDir: join(workRoot, "ocr-runtime"),
        ocrDevice: "cpu",
        ocrBboxMode: "ocr",
        ocrEngine: "paddle_static",
        ocrVersion: "PP-OCRv6",
        ocrTextDetectionModelName: "PP-OCRv6_small_det",
        ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
        ocrMergeMode: "semantic",
        sourceLanguage: "ja",
      },
    );
    expect(KOHARU_SMOKE_ASSETS.map((asset) => asset.model)).toEqual([
      "aot-inpainting",
      "lama-manga",
    ]);
    expect(
      createKoharuSmokeRequest(
        "lama-manga",
        {
          input: "input.png",
          mask: "mask.png",
          bubble: "bubble.png",
        },
        "output.png",
      ),
    ).toEqual({
      type: "inpaint",
      id: "lama-manga",
      input: "input.png",
      mask: "mask.png",
      bubble_mask: "bubble.png",
      output: "output.png",
      windows: [[32, 32, 96, 96]],
      max_pixels: 128 * 128,
    });

    expect(
      createApplicationSmokeLaunch("/Applications/Smoke.app", "verify"),
    ).toEqual({
      command: "open",
      args: [
        "-W",
        "-n",
        "-F",
        "-g",
        "/Applications/Smoke.app",
        "--args",
        "--mgt-mac-package-smoke=alpha-ci-v1",
        "--mgt-mac-package-smoke-stage=verify",
        "--disable-gpu",
        "--enable-logging=stderr",
        "--v=1",
      ],
      options: { timeout: 120_000 },
    });
    const diagnostic = createDiagnosticExcerpt("x".repeat(40 * 1024));
    expect(diagnostic).toContain("middle omitted");
    expect(diagnostic.length).toBeLessThan(40 * 1024);
  });

  it("executes the unpacked app verification contract in order", async () => {
    const calls: string[] = [];
    const record = (name: string) => (_appPath: string) => calls.push(name);

    await verifyUnpackedApplication("/dist/App.app", {
      assertFramework: record("framework"),
      assertHelpers: record("helpers"),
      verifyNative: record("native"),
      verifyChannel: record("channel"),
      verifySignature: record("signature"),
      verifyTar: record("tar"),
      verifyApplicationSmoke: record("application-smoke"),
      verifyRuntimes: record("runtimes"),
      verifyRuntimeSmokes: async ({ appPath }) => {
        expect(appPath).toBe("/dist/App.app");
        calls.push("runtime-smokes");
      },
    });

    expect(calls).toEqual([
      "framework",
      "helpers",
      "native",
      "channel",
      "signature",
      "tar",
      "application-smoke",
      "runtimes",
      "runtime-smokes",
      "signature",
    ]);
    expect(
      resolveMacArtifactSet(["notes.txt", "release.dmg", "release.zip"]),
    ).toEqual({
      diskImage: "release.dmg",
      zipArchive: "release.zip",
    });
    expect(() => resolveMacArtifactSet(["one.dmg", "two.dmg"])).toThrow(
      "Expected one arm64 DMG and ZIP",
    );
  });

  it("validates marker results and final archive command plans", () => {
    expect(() =>
      assertPreparedSmoke({
        ok: true,
        stage: "prepared",
        imported: true,
        saved: true,
        exported: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertVerifiedSmoke({
        ok: true,
        stage: "verified",
        platform: "darwin",
        arch: "arm64",
        imported: true,
        saved: true,
        restarted: true,
        exported: true,
        dataRoot: join(
          "Users",
          "runner",
          "Library",
          "Application Support",
          "manga-gemma-translator",
        ),
      }),
    ).not.toThrow();
    expect(() => assertPreparedSmoke({ stage: "prepared" })).toThrow(
      "Invalid packaged prepare smoke result",
    );
    expect(createDiskImageAttachCommand("release.dmg", "/tmp/mount")).toEqual({
      command: "hdiutil",
      args: [
        "attach",
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        "/tmp/mount",
        "-plist",
        "release.dmg",
      ],
      options: { timeout: 120_000 },
    });
    expect(createZipExtractCommand("release.zip", "/tmp/extract")).toEqual({
      command: "ditto",
      args: ["-x", "-k", "release.zip", "/tmp/extract"],
      options: { timeout: 300_000 },
    });
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
});

function loadMacBuilderConfig(
  runtimeRoot: string,
  channel: "mac-alpha" | "stable",
  signingMode: "adhoc" | "developer-id",
): ElectronBuilderMacConfig {
  const modulePath = require.resolve("../electron-builder.config.cjs");
  const keys = [
    "MGT_TARGET_PLATFORM",
    "MGT_MAC_RUNTIME_ROOT",
    "MGT_MAC_SIGNING_MODE",
    "MGT_RELEASE_CHANNEL",
    "MANGA_TRANSLATOR_BUILD_CHANNEL",
  ] as const;
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof keys)[number], string | undefined>;

  process.env.MGT_TARGET_PLATFORM = "darwin";
  process.env.MGT_MAC_RUNTIME_ROOT = runtimeRoot;
  process.env.MGT_MAC_SIGNING_MODE = signingMode;
  process.env.MGT_RELEASE_CHANNEL = channel;
  process.env.MANGA_TRANSLATOR_BUILD_CHANNEL = channel;
  delete require.cache[modulePath];
  try {
    return require(modulePath) as ElectronBuilderMacConfig;
  } finally {
    delete require.cache[modulePath];
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
