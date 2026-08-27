import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyPackagedData, type AppPaths } from "../src/main/appPaths";
import {
  resolvePackagedBootstrapLogPath,
  resolvePackagedElectronStoragePaths,
} from "../src/main/electronStoragePaths";

const repoRoot = join(__dirname, "..");
const require = createRequire(import.meta.url);
const { nsisTemplatesDir } =
  require("app-builder-lib/out/targets/nsis/nsisUtil") as {
    nsisTemplatesDir: string;
  };
const {
  FAST_ZIP_COMPRESSION_LEVEL,
  copyTemplateDirectory,
  patchNsisTemplates,
} = require("../scripts/build-windows-installer.cjs") as {
  FAST_ZIP_COMPRESSION_LEVEL: string;
  copyTemplateDirectory: (sourceDir: string, targetDir: string) => void;
  patchNsisTemplates: (templatesDir: string) => void;
};
const {
  MAX_FAST_ZIP_INSTALL_DIR_LENGTH,
  MAX_FAST_ZIP_RELATIVE_PATH_LENGTH,
  WINDOWS_EXECUTABLE_BASENAME,
  WINDOWS_EXECUTABLE_FILENAME,
  assertFastZipPayload,
} = require("../scripts/installer-zip-safety.cjs") as {
  MAX_FAST_ZIP_INSTALL_DIR_LENGTH: number;
  MAX_FAST_ZIP_RELATIVE_PATH_LENGTH: number;
  WINDOWS_EXECUTABLE_BASENAME: string;
  WINDOWS_EXECUTABLE_FILENAME: string;
  assertFastZipPayload: (appOutDir: string) => {
    entries: number;
    maxRelativePathLength: number;
  };
};
const { prepareRuntimeAssets } = require("../scripts/prepare-runtime.cjs") as {
  prepareRuntimeAssets: (options: {
    root: string;
    outputDir: string;
    runtimeModulesOnly?: boolean;
  }) => string;
};
const { resolveTargetRuntime } =
  require("../scripts/stage-onnxruntime-node.cjs") as {
    resolveTargetRuntime: (options?: {
      hostPlatform?: NodeJS.Platform;
      requestedPlatform?: string;
    }) => { platform: string; arch: string; binarySource: string };
  };
const electronBuilderConfig: unknown = require("../electron-builder.config.cjs");
const bundledPythonRuntimeAvailable = existsSync(
  join(repoRoot, "tools", "python"),
);
const { smokeOpenAiOauthRuntime } =
  require("../scripts/smoke-openai-oauth-runtime.cjs") as {
    smokeOpenAiOauthRuntime: (
      runtimePath: string,
      nativeImportModulePath: string,
      options?: { log?: (message: string) => void },
    ) => Promise<{ port: number; url: string }>;
  };

describe("Windows installer clean uninstall option", () => {
  it("exposes the intended electron-builder behavior as configuration", () => {
    expect(electronBuilderConfig).toMatchObject({
      publish: [
        {
          provider: "github",
          owner: "ucx0204",
          repo: "CarrotMangaTranslator",
        },
      ],
      files: expect.arrayContaining([
        "!dist{,/**/*}",
        "!artifacts{,/**/*}",
        "!datasets{,/**/*}",
        "!coverage{,/**/*}",
        "!ocr-runtime{,/**/*}",
        "!hf-cache{,/**/*}",
        "!llama.cpp{,/**/*}",
        "!runtime{,/**/*}",
        "!results{,/**/*}",
        "!testProject1{,/**/*}",
        "!.settings-pairs{,/**/*}",
        "!settings.commit.json",
        "!settings.secrets.json",
        "!block-library.json",
        "!linked-workspaces.json",
        "!linked-sync-queue.json",
        "!tmp{,/**/*}",
        "!.tmp-*{,/**/*}",
        "!.pytest_cache{,/**/*}",
        "!.ruff_cache{,/**/*}",
        "!.claude{,/**/*}",
        "!.mgt-instance-lock{,/**/*}",
        "!.mgt-instance-candidate-*{,/**/*}",
        "!.mgt-instance-stale-*{,/**/*}",
        "!.mgt-instance-release-*{,/**/*}",
        "!fonts{,/**/*}",
        "!panel-window-bounds.json",
        "!recent-dialog-paths.json",
        "!docs{,/**/*}",
        "!node_modules/onnxruntime-web/docs{,/**/*}",
        "!node_modules/onnxruntime-web/lib{,/**/*}",
        "!node_modules/onnxruntime-web/dist/!(ort.node.min.js)",
        "!node_modules/**/.v8-cache{,/**/*}",
        "!node_modules/{flatbuffers,guid-typescript,long,platform,protobufjs}{,/**/*}",
        "!node_modules/@protobufjs{,/**/*}",
      ]),
      extraResources: expect.arrayContaining([
        {
          from: "out/app-runtime",
          to: "app-runtime",
          filter: [
            "**/*",
            "!o{,/**/*}",
            "!font-matching{,/**/*}",
            "!font-matching-crossscript-proxy{,/**/*}",
          ],
        },
        {
          from: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
          to: "app-runtime/onnxruntime-web/1.27.0/ort-wasm-simd-threaded.mjs",
        },
        {
          from: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
          to: "app-runtime/onnxruntime-web/1.27.0/ort-wasm-simd-threaded.wasm",
        },
        {
          from: "out/app-runtime/o",
          to: "o",
          filter: ["**/*"],
        },
      ]),
      nsis: {
        differentialPackage: false,
        include: "build/installer.nsh",
        useZip: true,
      },
      win: expect.objectContaining({
        electronLanguages: ["en-US", "en-GB", "ko", "ja", "zh-CN", "zh-TW"],
        executableName: WINDOWS_EXECUTABLE_BASENAME,
        extraResources: expect.arrayContaining([
          {
            from: "tools/ffmpeg",
            to: "tools/ffmpeg",
          },
          ...(bundledPythonRuntimeAvailable
            ? [
                expect.objectContaining({
                  from: "tools/python",
                  filter: expect.arrayContaining([
                    "!**/site-packages/pkg_resources/**",
                    "!**/Scripts/pip*.exe",
                    "!**/Scripts/wheel.exe",
                  ]),
                }),
              ]
            : []),
        ]),
      }),
      afterPack: expect.any(Function),
    });
    expect(electronBuilderConfig).not.toHaveProperty("asarUnpack");
  });

  it("does not ship renderer-only or build-only packages twice", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      overrides: Record<string, Record<string, string>>;
    };
    const bundledOnlyPackages = [
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "@tabler/icons-react",
      "@types/yauzl",
      "adm-zip",
      "openai-oauth",
      "react",
      "react-dom",
      "react-i18next",
    ];

    for (const packageName of bundledOnlyPackages) {
      expect(packageJson.dependencies).not.toHaveProperty(packageName);
      expect(packageJson.devDependencies).toHaveProperty(packageName);
    }
    for (const runtimePackage of [
      "i18next",
      "onnxruntime-node",
      "onnxruntime-web",
      "yauzl",
      "zod",
    ]) {
      expect(packageJson.dependencies).toHaveProperty(runtimePackage);
    }
    expect(packageJson.dependencies["onnxruntime-web"]).toBe("1.27.0");
    expect(packageJson.dependencies["onnxruntime-node"]).toBe("1.27.0");
    expect(packageJson.overrides["onnxruntime-node"]?.["adm-zip"]).toBe(
      "^0.6.0",
    );
  });

  it("fails closed instead of staging Windows native ONNX bytes for an unsupported platform", () => {
    expect(resolveTargetRuntime({ hostPlatform: "win32" })).toMatchObject({
      platform: "win32",
      arch: "x64",
    });
    expect(
      resolveTargetRuntime({
        hostPlatform: "win32",
        requestedPlatform: "darwin",
      }),
    ).toMatchObject({ platform: "darwin", arch: "arm64" });
    expect(() => resolveTargetRuntime({ hostPlatform: "linux" })).toThrow(
      "supports only win32 x64 and darwin arm64",
    );
    expect(() =>
      resolveTargetRuntime({
        hostPlatform: "win32",
        requestedPlatform: "freebsd",
      }),
    ).toThrow("Unsupported MGT_TARGET_PLATFORM");
  });

  it("budgets the externalized font runtime without allowing training data into the package", () => {
    const packagedRuntimeVerifier = readFileSync(
      join(repoRoot, "scripts", "verify-packaged-runtime.cjs"),
      "utf8",
    );

    // The trained font matching runtime bundle is externalized out of the
    // installer (downloaded on first use), so the unpacked size budget guards
    // the ~745 MiB floor without the bundle and rejects the 467 MiB bundle
    // returning (~1212 MiB).
    expect(packagedRuntimeVerifier).toContain(
      "const MAX_PACKAGED_BYTES = 1000 * 1024 * 1024;",
    );
    expect(packagedRuntimeVerifier).toContain(
      "const MAX_PACKAGED_FILES = 299;",
    );
    expect(packagedRuntimeVerifier).toContain(
      "const mainRuntimeSmokeMessage = runPackagedMainRuntimeSmoke();",
    );
    expect(packagedRuntimeVerifier).toContain(
      '"--mgt-packaged-main-runtime-smoke=module-graph-v1"',
    );
    expect(packagedRuntimeVerifier).toContain(
      "MANGA_TRANSLATOR_DATA_ROOT: smokeRoot",
    );
    expect((electronBuilderConfig as { files: string[] }).files).toEqual(
      expect.arrayContaining([
        "!artifacts{,/**/*}",
        "!datasets{,/**/*}",
        "!coverage{,/**/*}",
        "!.tmp-*{,/**/*}",
        "!results{,/**/*}",
        "!.settings-pairs{,/**/*}",
        "!settings.commit.json",
        "!settings.secrets.json",
        "!block-library.json",
        "!linked-workspaces.json",
        "!linked-sync-queue.json",
      ]),
    );
  });

  it("refuses mismatched release metadata and publishes notes with the policy link", () => {
    const releaseWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );

    expect(releaseWorkflow).toContain("fetch-depth: 0");
    expect(releaseWorkflow).toContain(
      '$expectedRef = "refs/heads/${{ github.event.repository.default_branch }}"',
    );
    expect(releaseWorkflow).toContain(
      "Release workflow must run from '$expectedRef'",
    );
    expect(releaseWorkflow).toContain('$expectedTag = "v$version"');
    expect(releaseWorkflow).toContain(
      "does not match package version '$version'",
    );
    expect(releaseWorkflow).toContain(
      '$notesPath = "docs/release-notes/$tag.md"',
    );
    expect(releaseWorkflow).toContain("$existingTags = @(git tag --list $tag)");
    expect(releaseWorkflow).toContain("if ($existingTags -contains $tag)");
    expect(releaseWorkflow).toContain("not ${{ github.sha }}");
    expect(releaseWorkflow).toContain("body = $releaseNotes");
    expect(releaseWorkflow).toContain("[Code signing policy]($policyUrl)");
    expect(releaseWorkflow).toContain("function Invoke-GitHubApiWithRetry");
    expect(releaseWorkflow).toContain(
      "$retryableStatusCodes = @(0, 408, 429, 500, 502, 503, 504)",
    );
    expect(releaseWorkflow).toContain("-RecoveryUri $releaseByTagUri");
    expect(releaseWorkflow).toContain(
      "Expected exactly one Windows installer matching",
    );
    expect(releaseWorkflow).toContain(
      "node scripts/smoke-windows-installer.cjs",
    );
  });

  it("shows useful progress details and patches only expected NSIS stages", () => {
    const installerScript = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(installerScript).toContain("!macro customHeader");
    expect(installerScript).toContain("ShowInstDetails show");
    expect(installerScript).toContain("!ifndef BUILD_UNINSTALLER");
    expect(installerScript).not.toContain("ShowUninstDetails show");
    expect(installerScript).toContain("!macro customFiles_x64");
    expect(installerScript).toContain(
      'DetailPrint "프로그램 파일 압축 해제를 완료했습니다."',
    );

    expect(FAST_ZIP_COMPRESSION_LEVEL).toBe("1");
  });

  it("loads the OAuth runtime through the packaged import boundary and closes it", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-oauth-smoke-"));
    const runtimePath = join(temporaryRoot, "oauth-runtime.mjs");
    const nativeImportPath = join(temporaryRoot, "native-import.cjs");
    const closeMarkerPath = join(temporaryRoot, "closed.txt");
    const logLines: string[] = [];

    try {
      writeFileSync(
        runtimePath,
        [
          'import { writeFileSync } from "node:fs";',
          "export async function startOpenAIOAuthServer(options) {",
          '  if (options.host !== "127.0.0.1" || options.port !== 0) throw new Error("invalid bind options");',
          "  return {",
          "    port: 43123,",
          '    url: "http://127.0.0.1:43123",',
          `    async close() { writeFileSync(${JSON.stringify(closeMarkerPath)}, "closed"); },`,
          "  };",
          "}",
        ].join("\n"),
      );
      writeFileSync(
        nativeImportPath,
        "exports.importNativeEsm = (href) => import(href);\n",
      );

      await expect(
        smokeOpenAiOauthRuntime(runtimePath, nativeImportPath, {
          log: (message) => logLines.push(message),
        }),
      ).resolves.toEqual({
        port: 43123,
        url: "http://127.0.0.1:43123",
      });
      expect(logLines).toEqual([
        "packaged-oauth-runtime-ok http://127.0.0.1:43123",
      ]);
      expect(readFileSync(closeMarkerPath, "utf8")).toBe("closed");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("strictly patches the actual electron-builder NSIS templates", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-nsis-test-"));
    const temporaryTemplatesDir = join(
      temporaryRoot,
      basename(nsisTemplatesDir),
    );

    try {
      copyTemplateDirectory(nsisTemplatesDir, temporaryTemplatesDir);
      patchNsisTemplates(temporaryTemplatesDir);

      const installSection = readFileSync(
        join(temporaryTemplatesDir, "installSection.nsh"),
        "utf8",
      );
      const extractPackage = readFileSync(
        join(temporaryTemplatesDir, "include", "extractAppPackage.nsh"),
        "utf8",
      );
      const installerFunctions = readFileSync(
        join(temporaryTemplatesDir, "include", "installer.nsh"),
        "utf8",
      );

      expect(installSection).toContain(
        '${IfNot} ${Silent}\n  SetDetailsPrint both\n  DetailPrint "설치 준비 중..."\n${endif}',
      );
      expect(installSection).toContain(
        '!insertmacro installApplicationFiles\nDetailPrint "설치 정보를 등록하고 바로가기를 만드는 중..."\n!insertmacro registryAddInstallInfo',
      );
      expect(installSection).toContain(
        "Call MgtValidateInstallDirectory\n!insertmacro uninstallOldVersion SHELL_CONTEXT",
      );
      expect(installSection).not.toContain(
        "${IfNot} ${Silent}\n  SetDetailsPrint none\n${endif}",
      );
      expect(extractPackage).toContain(
        '    DetailPrint "프로그램 파일 압축을 해제하는 중..."\n    StrCpy $R1 0\n    MgtZipExtractRetry:',
      );
      expect(extractPackage).toContain(
        '      nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"',
      );
      expect(extractPackage).toContain(
        '      StrCmp $R0 "success" MgtZipExtractDone',
      );
      expect(extractPackage).toContain(
        "      ${If} $R1 < 3\n        Sleep 750",
      );
      expect(extractPackage).toContain(
        '      DetailPrint "압축 해제 재시도 $R1/3: $R0"',
      );
      expect(extractPackage).not.toContain('    StrCmp $R0 "success" +3');
      expect(installerFunctions).toContain(
        "      ; Manual GitHub-release updates do not use electron-updater's cached installer.",
      );
      expect(installerFunctions).not.toContain(
        '      !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"',
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects payload paths that nsisunz cannot safely extract", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-zip-safety-test-"));

    try {
      const resourcesDir = join(temporaryRoot, "resources");
      mkdirSync(resourcesDir);
      writeFileSync(
        join(temporaryRoot, WINDOWS_EXECUTABLE_FILENAME),
        "executable",
      );
      writeFileSync(join(resourcesDir, "app.asar"), "asar");

      expect(assertFastZipPayload(temporaryRoot)).toEqual({
        entries: 3,
        maxRelativePathLength: WINDOWS_EXECUTABLE_FILENAME.length,
      });

      writeFileSync(join(resourcesDir, "한글.txt"), "unsafe");
      expect(() => assertFastZipPayload(temporaryRoot)).toThrow(
        "non-ASCII paths",
      );
      unlinkSync(join(resourcesDir, "한글.txt"));

      const longFilename = `${"a".repeat(
        MAX_FAST_ZIP_RELATIVE_PATH_LENGTH,
      )}.txt`;
      writeFileSync(join(temporaryRoot, longFilename), "too long");
      expect(() => assertFastZipPayload(temporaryRoot)).toThrow(
        "safety budget",
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps the complete app runtime inside the Fast ZIP path budget", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mgt-runtime-zip-safety-test-"),
    );
    const sourceRuntime = join(temporaryRoot, "src", "main", "runtime");
    const appOutDir = join(temporaryRoot, "package");

    try {
      copyTemplateDirectory(
        join(repoRoot, "src", "main", "runtime"),
        sourceRuntime,
      );
      prepareRuntimeAssets({
        root: temporaryRoot,
        outputDir: join(appOutDir, "resources", "app-runtime"),
        runtimeModulesOnly: true,
      });
      const fontMatchingDir = join(
        appOutDir,
        "resources",
        "app-runtime",
        "font-matching",
      );
      mkdirSync(fontMatchingDir, { recursive: true });
      writeFileSync(
        join(fontMatchingDir, "selection-calibration.json"),
        "fixture",
      );
      writeFileSync(join(appOutDir, WINDOWS_EXECUTABLE_FILENAME), "executable");

      expect(
        assertFastZipPayload(appOutDir).maxRelativePathLength,
      ).toBeLessThanOrEqual(MAX_FAST_ZIP_RELATIVE_PATH_LENGTH);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails loudly if an electron-builder NSIS sentinel changes", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mgt-nsis-sentinel-test-"),
    );
    const temporaryTemplatesDir = join(
      temporaryRoot,
      basename(nsisTemplatesDir),
    );

    try {
      copyTemplateDirectory(nsisTemplatesDir, temporaryTemplatesDir);
      const installSectionPath = join(
        temporaryTemplatesDir,
        "installSection.nsh",
      );
      const installSection = readFileSync(installSectionPath, "utf8");
      const changedTemplate = installSection.replace(
        "  SetDetailsPrint none",
        "  SetDetailsPrint textonly",
      );
      expect(changedTemplate).not.toBe(installSection);
      writeFileSync(installSectionPath, changedTemplate, "utf8");

      expect(() => patchNsisTemplates(temporaryTemplatesDir)).toThrow(
        "Expected exactly one installer details fragment",
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("builds one thin Windows installer instead of separate NVIDIA/AMD bundles", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    const releaseWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );

    expect(packageJson.scripts["dist:win"]).toBe(
      "node scripts/dist-win-thin.cjs",
    );
    expect(packageJson.scripts["dist:win:nvidia"]).toBe(
      "node scripts/dist-win-thin.cjs --with-flux-nvidia",
    );
    expect(packageJson.scripts["dist:win:amd"]).toBe(
      "node scripts/dist-win-thin.cjs",
    );
    expect(releaseWorkflow).toContain('MGT_THIN_INSTALLER: "1"');
    expect(releaseWorkflow).not.toContain("Prepare bundled Python runtime");
    expect(releaseWorkflow).not.toContain("Prepare bundled Flux CUDA runtime");
  });

  it("offers an optional clean uninstall section for app data and OCR cache", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain("customPageAfterChangeDir");
    expect(script).toContain("MgtDataRootPageCreate");
    expect(script).toContain("data-root.txt");
    expect(script).toContain(".manga-gemma-translator-data");
    expect(script).toContain("customRemoveFiles");
    expect(script).toContain("customUnInstallSection");
    expect(script).toContain('Section /o "un.');
    expect(script).toContain("$INSTDIR\\data");
    expect(script).toContain("$MgtDataRoot\\ocr-runtime");
    expect(script).toContain('Delete "$MgtDataRoot\\recent-dialog-paths.json"');
    expect(script).toContain("$LOCALAPPDATA\\manga-gemma-translator");
    expect(script).toContain("$APPDATA\\망가번역기");
    expect(script).toContain('!define APP_FILENAME "carrot-manga-translator"');
    expect(script).toContain(
      `Delete "$INSTDIR\\${WINDOWS_EXECUTABLE_FILENAME}"`,
    );
  });

  it("validates nsisunz install-path length before uninstalling an old version", () => {
    const installerScript = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(WINDOWS_EXECUTABLE_BASENAME).toBe("CarrotMangaTranslator");
    expect(installerScript).toContain(
      `!define MGT_MAX_FAST_ZIP_INSTALL_DIR_LENGTH ${MAX_FAST_ZIP_INSTALL_DIR_LENGTH}`,
    );
    expect(installerScript).toContain("Function MgtValidateInstallDirectory");
  });

  it("keeps the user-selected data root instead of recalculating it during install", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain('${If} $MgtDataRoot == ""');
    expect(script).toContain('StrCpy $MgtDataRoot "$INSTDIR\\data"');
    expect(script).toContain('FileWrite $0 "$MgtDataRoot$\\r$\\n"');
    expect(script).toContain("MgtResolveLegacyAppDataDefault");
    expect(script).toContain(
      "기존 데이터가 발견되어 해당 위치를 기본값으로 표시합니다",
    );
    expect(script).toContain(
      'StrCpy $MgtDataRoot "$LOCALAPPDATA\\manga-gemma-translator"',
    );
  });

  it("does not let the default uninstaller recursively remove the data folder", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain(
      "electron-builder's default uninstaller removes $INSTDIR recursively",
    );
    expect(script).toContain('RMDir /r "$INSTDIR\\resources"');
    expect(script).toContain('RMDir "$INSTDIR"');
    expect(script).not.toContain("RMDir /r $INSTDIR");
    expect(script).not.toContain('RMDir /r "$INSTDIR"');
    expect(script).not.toContain('RMDir /r "$INSTDIR\\data"');
  });

  it("guards selected data cleanup with marker and root-directory checks", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain("un.MgtEnsureSafeDataRoot");
    expect(script).toContain('StrCpy $4 "0"');
    expect(script).toContain("Data root marker missing. Skip cleanup");
    expect(script).toContain("Data root looks like a drive root. Skip cleanup");
    expect(script).toContain('${If} $4 == "1"');
    expect(script).toContain(
      'FileOpen $0 "$MgtDataRoot\\.manga-gemma-translator-data.tmp" w',
    );
  });

  it("trims only CR/LF from data-root pointers", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain("MgtTrimDataRootNewlines");
    expect(script).toContain('OrIf} $3 == "$\\n"');
    expect(script).not.toContain("StrCpy $MgtDataRoot $MgtDataRoot -2");
  });

  it("migrates only supported legacy user data into the configured root", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-data-migration-"));
    const executableDir = join(temporaryRoot, "application");
    const dataRoot = join(temporaryRoot, "configured-data");
    const portableData = join(executableDir, "data");
    const legacyUserData = join(temporaryRoot, "legacy-user-data");
    const paths: AppPaths = {
      isPackaged: true,
      repoRoot: temporaryRoot,
      executableDir,
      resourcesDir: join(temporaryRoot, "resources"),
      dataRoot,
      settingsPath: join(dataRoot, "settings.json"),
      libraryDir: join(dataRoot, "library"),
      fontsDir: join(dataRoot, "fonts"),
      logsDir: join(dataRoot, "logs"),
      logFile: join(dataRoot, "logs", "app.log"),
      runtimeDir: join(temporaryRoot, "resources", "app-runtime"),
      toolsDir: join(temporaryRoot, "resources", "tools"),
      ocrRuntimeDir: join(dataRoot, "ocr-runtime"),
      llamaRuntimeDir: join(temporaryRoot, "resources", "tools", "llama"),
      llamaServerPath: join(
        temporaryRoot,
        "resources",
        "tools",
        "llama",
        "llama-server.exe",
      ),
    };

    try {
      migrateLegacyPackagedData({ ...paths, isPackaged: false }, [
        legacyUserData,
      ]);
      expect(existsSync(dataRoot)).toBe(false);

      mkdirSync(join(portableData, "library"), { recursive: true });
      writeFileSync(join(portableData, "library", "portable.json"), "portable");
      mkdirSync(join(legacyUserData, "library"), { recursive: true });
      mkdirSync(join(legacyUserData, "fonts"), { recursive: true });
      mkdirSync(join(legacyUserData, "hf-cache"), { recursive: true });
      mkdirSync(join(legacyUserData, "ocr-runtime"), { recursive: true });
      writeFileSync(join(legacyUserData, "settings.json"), "settings");
      writeFileSync(join(legacyUserData, "library", "legacy.json"), "library");
      writeFileSync(join(legacyUserData, "fonts", "font.ttf"), "font");
      writeFileSync(join(legacyUserData, "hf-cache", "model.bin"), "model");
      writeFileSync(
        join(legacyUserData, "ocr-runtime", "runtime.bin"),
        "runtime",
      );

      migrateLegacyPackagedData(paths, [legacyUserData]);

      expect(readFileSync(join(dataRoot, "settings.json"), "utf8")).toBe(
        "settings",
      );
      expect(
        readFileSync(join(dataRoot, "library", "portable.json"), "utf8"),
      ).toBe("portable");
      expect(
        readFileSync(join(dataRoot, "library", "legacy.json"), "utf8"),
      ).toBe("library");
      expect(readFileSync(join(dataRoot, "fonts", "font.ttf"), "utf8")).toBe(
        "font",
      );
      expect(() =>
        readFileSync(join(dataRoot, "hf-cache", "model.bin"), "utf8"),
      ).toThrow();
      expect(() =>
        readFileSync(join(dataRoot, "ocr-runtime", "runtime.bin"), "utf8"),
      ).toThrow();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("resolves every packaged Electron storage path below the data root", () => {
    const dataRoot = join("D:\\", "MangaData");

    const storage = resolvePackagedElectronStoragePaths(dataRoot);

    expect(storage).toEqual({
      userDataDir: join(dataRoot, "electron-user-data"),
      sessionDataDir: join(dataRoot, "electron-session"),
      tempDir: join(dataRoot, "tmp", "system-temp"),
      diskCacheDir: join(dataRoot, "electron-session", "Cache"),
    });
    expect(resolvePackagedBootstrapLogPath(storage.userDataDir)).toBe(
      join(dataRoot, "electron-user-data", "logs", "bootstrap.log"),
    );
  });
});
