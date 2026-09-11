const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const {
  copyTemplateDirectory,
  patchNsisTemplates,
  setNsisTemplatesDir,
} = require("./build-windows-installer.cjs");

/**
 * CI-only packaging/installation fixture, never a runnable application release.
 * Uses a fresh product identity and directories created by this process only.
 * A hosted elevated runner can test protected writes, not interactive consent
 * or Explorer drag-and-drop. Those remain separate manual acceptance cases.
 */
async function main() {
  assert.equal(process.platform, "win32", "Windows is required.");
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Run on disposable CI only.",
  );
  const repository = resolve(__dirname, "..");
  const scratchParent = join(repository, ".tmp");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, "windows-uac-smoke-"));
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles;
  assert.ok(programFiles, "Program Files is unavailable.");
  const installDir = mkdtempSync(
    join(programFiles, "carrot-manga-translator-uac-smoke-"),
  );
  const fixtureId = installDir.split("-").at(-1);
  const staged = join(scratch, "payload");
  const output = join(scratch, "output");
  const templates = join(scratch, "nsis-templates");
  const diagnostics = join(scratch, "nsis-failures.log");
  const installerInclude = stageDiagnosticIncludes(repository, scratch);
  mkdirSync(join(staged, "resources"), { recursive: true });
  // NSIS must install/remove the real executable filename, but this fixture
  // intentionally contains no runnable app or user data.
  writeFileSync(join(staged, "CarrotMangaTranslator.exe"), "CI fixture only\n");
  writeFileSync(join(staged, "resources", "fixture.txt"), "CI fixture only\n");
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({
      name: `carrot-uac-fixture-${fixtureId}`,
      version: "0.0.1",
      description: "Isolated Windows installer permission smoke fixture",
      author: "CarrotMangaTranslator",
      main: "index.js",
    }),
  );
  const configPath = join(scratch, "fixture-builder.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      extends: null,
      appId: `com.carrot.uacfixture.${fixtureId}`,
      productName: `Carrot UAC Fixture ${fixtureId}`,
      directories: { output },
      win: {
        executableName: "CarrotMangaTranslator",
        requestedExecutionLevel: "asInvoker",
        signAndEditExecutable: false,
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        differentialPackage: false,
        useZip: true,
        include: installerInclude,
        runAfterFinish: false,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        artifactName: "carrot-uac-fixture.exe",
      },
    }),
  );

  const nsisUtil = require("app-builder-lib/out/targets/nsis/nsisUtil");
  const originalTemplates = nsisUtil.nsisTemplatesDir;
  const oldCompression = process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
  try {
    copyTemplateDirectory(originalTemplates, templates);
    patchNsisTemplates(templates);
    setNsisTemplatesDir(nsisUtil, templates);
    process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = "1";
    const { Arch, Platform, build } = require("electron-builder");
    await build({
      projectDir: scratch,
      config: configPath,
      prepackaged: staged,
      targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
      publish: "never",
    });

    const setup = join(output, "carrot-uac-fixture.exe");
    assert.ok(existsSync(setup), "The fixture installer was not built.");
    assertManifestLevel(setup, "requireAdministrator");
    for (const scope of ["/currentuser", "/allusers"]) {
      const installArgs = ["/S", scope, `/D=${installDir}`];
      runNsis(setup, installArgs, scratch);
      const pointer = join(installDir, "data-root.txt");
      const dataRoot = readFileSync(pointer, "utf8").trim();
      assert.equal(
        dataRoot.toLowerCase(),
        join(installDir, "data").toLowerCase(),
      );
      assert.ok(existsSync(join(dataRoot, ".manga-gemma-translator-data")));
      const library = join(dataRoot, "library");
      mkdirSync(library, { recursive: true });
      const sentinel = join(library, "fixture-preservation.txt");
      writeFileSync(sentinel, "keep this fixture data\n");

      runNsis(setup, installArgs, scratch);
      assert.equal(readFileSync(pointer, "utf8").trim(), dataRoot);
      assert.equal(readFileSync(sentinel, "utf8"), "keep this fixture data\n");
      assert.ok(existsSync(join(installDir, "CarrotMangaTranslator.exe")));

      // A broken data destination must fail before the old executable is removed.
      const pointerBytes = readFileSync(pointer);
      const blocked = join(scratch, "blocked-data-root");
      writeFileSync(blocked, "not a directory\n");
      try {
        writeFileSync(pointer, `${blocked}\r\n`);
        runNsis(setup, installArgs, scratch, 2);
        assert.ok(existsSync(join(installDir, "CarrotMangaTranslator.exe")));
        assert.equal(
          readFileSync(sentinel, "utf8"),
          "keep this fixture data\n",
        );
        assert.equal(readFileSync(pointer, "utf8").trim(), blocked);
      } finally {
        writeFileSync(pointer, pointerBytes);
      }

      const uninstallName = readdirSync(installDir).find((name) =>
        /^Uninstall .*\.exe$/i.test(name),
      );
      assert.ok(uninstallName, "No generated uninstaller was installed.");
      // Run a private copy with NSIS's _?= argument to await actual removal,
      // rather than the short-lived process that starts a temporary copy.
      const uninstall = join(scratch, "uninstall-fixture.exe");
      copyFileSync(join(installDir, uninstallName), uninstall);
      assertManifestLevel(uninstall, "asInvoker");
      runNsis(
        uninstall,
        ["/S", scope, "/MGT-UNINSTALL-SID=S-1-0-0", `_?=${installDir}`],
        scratch,
        2,
      );
      assert.ok(existsSync(join(installDir, "CarrotMangaTranslator.exe")));
      assert.equal(readFileSync(sentinel, "utf8"), "keep this fixture data\n");
      runNsis(uninstall, ["/S", scope, `_?=${installDir}`], scratch);
      assert.equal(
        existsSync(join(installDir, "CarrotMangaTranslator.exe")),
        false,
      );
      assert.equal(existsSync(join(installDir, "resources")), false);
      assert.equal(readFileSync(pointer, "utf8").trim(), dataRoot);
      assert.equal(readFileSync(sentinel, "utf8"), "keep this fixture data\n");
      console.log(
        `[windows-uac-smoke] ${scope}: install, repair, remove, preserve OK`,
      );
      console.log(
        `[windows-uac-smoke] ${scope}: bad destination and wrong account blocked`,
      );
    }
    console.log(
      "[windows-uac-smoke] interactive UAC and Explorer behavior NOT tested",
    );
  } finally {
    if (existsSync(diagnostics)) {
      console.log(readFileSync(diagnostics, "utf8"));
    }
    console.log("[windows-uac-smoke] remaining fixture entries:", {
      installDir,
      entries: existsSync(installDir) ? readdirSync(installDir) : [],
    });
    setNsisTemplatesDir(nsisUtil, originalTemplates);
    if (oldCompression === undefined) {
      delete process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
    } else {
      process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = oldCompression;
    }
    // Both directories were freshly allocated above on an isolated CI runner.
    // Never use a configured application data root as a cleanup target.
    rmSync(installDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Add observation only to already-decided failure branches in private copies.
 * Production source, success paths, predicates and exit codes stay unchanged.
 * @param {string} repository
 * @param {string} scratch
 */
function stageDiagnosticIncludes(repository, scratch) {
  const output = join(scratch, "build");
  const diagnosticPath = join(scratch, "nsis-failures.log");
  assert.ok(!/[\r\n$\"]/u.test(diagnosticPath));
  mkdirSync(output, { recursive: true });
  for (const filename of ["installer.nsh", "windows-uninstall-elevation.nsh"]) {
    const source = readFileSync(join(repository, "build", filename), "utf8");
    let section = "header";
    const lines = source.split(/\r?\n/u).map((line, index) => {
      const declaration = /^(?:Function|!macro) (\S+)/u.exec(line);
      if (declaration) section = declaration[1];
      if (line.trim() !== "SetErrorLevel 2") return line;
      return [
        "Push $R8",
        `FileOpen $R8 "${diagnosticPath}" a`,
        `FileWrite $R8 "${filename}:${index + 1} ${section}$\\r$\\nINSTDIR=$INSTDIR$\\r$\\nDATA=$MgtDataRoot$\\r$\\n1=$1 2=$2 3=$3 4=$4 5=$5 6=$6 9=$9$\\r$\\n"`,
        "FileClose $R8",
        "Pop $R8",
        line,
      ].join("\n");
    });
    writeFileSync(join(output, filename), lines.join("\n"));
  }
  return join(output, "installer.nsh");
}

/** @param {string} executable @param {string} expected */
function assertManifestLevel(executable, expected) {
  const bytes = readFileSync(executable);
  const manifest = bytes.toString("utf8");
  const level = /<requestedExecutionLevel\b[^>]*\blevel=["']([^"']+)['"]/.exec(
    manifest,
  );
  assert.equal(level?.[1], expected, `Unexpected manifest in ${executable}`);
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} expectedStatus
 */
function runNsis(executable, args, cwd, expectedStatus = 0) {
  console.log("[windows-uac-smoke] execute", executable, args);
  const result = spawnSync(executable, args, {
    cwd,
    argv0: `"${executable}"`,
    // /D= and _?= must be last and unquoted, including paths containing spaces.
    windowsVerbatimArguments: true,
    windowsHide: true,
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expectedStatus,
    `NSIS fixture failed (${result.status}): ${result.stderr || result.stdout}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    // main's finally has already restored templates and cleaned fixture paths.
    process.exit(1);
  });
}
