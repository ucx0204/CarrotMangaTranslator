const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, relative } = require("node:path");
const { MAC_RUNTIME_MANIFEST } = require("../mac-runtime-manifest.cjs");
const root = join(__dirname, "..", "..");
const { verifyApplicationDirectorySmoke } = require("./app-smoke.cjs");
const {
  assertElectronFrameworkExecutable,
  findSingleAppBundle,
  listFiles,
  looksLikeNativeBinary,
  resolveMacPackageChannel,
  run,
  runOtool,
} = require("./core.cjs");

/** @param {string} appPath @returns {string[]} */
function verifyNativePayload(appPath) {
  const files = listFiles(appPath);
  const forbidden = files.filter((filePath) =>
    /\.(?:exe|dll)$/i.test(filePath),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Windows payload found in macOS app: ${forbidden.join(", ")}`,
    );
  }

  /** @type {string[]} */
  const machOFiles = [];
  for (const filePath of files.filter(looksLikeNativeBinary)) {
    const description = run("file", ["-b", filePath]).stdout.trim();
    if (!description.includes("Mach-O")) {
      continue;
    }
    if (!/arm64/i.test(description) || /x86_64/i.test(description)) {
      throw new Error(`Non-arm64 Mach-O found: ${filePath}: ${description}`);
    }
    runOtool(filePath);
    run("codesign", ["--verify", "--strict", "--verbose=2", filePath]);
    machOFiles.push(filePath);
  }
  if (machOFiles.length === 0) {
    throw new Error(`No Mach-O payload found in ${appPath}`);
  }
  console.log(
    `[mac-verify] verified ${machOFiles.length} arm64 signed Mach-O files`,
  );
  return machOFiles;
}

/** @param {string} appPath */
function verifyRequiredRuntimes(appPath) {
  const toolsDir = join(appPath, "Contents", "Resources", "tools");
  for (const runtime of MAC_RUNTIME_MANIFEST.llamaRuntimes) {
    const server = join(toolsDir, runtime.id, "llama-server");
    if (!existsSync(server)) {
      throw new Error(`Missing bundled Gemma runtime: ${server}`);
    }
    const result = run(server, ["--list-devices"], { timeout: 60_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    if (!/(?:Metal|Apple)/i.test(output)) {
      throw new Error(
        `${runtime.id} did not report an Apple Metal device: ${output}`,
      );
    }
  }

  const python = join(toolsDir, "python", "bin", "python3");
  if (!existsSync(python)) {
    throw new Error(`Missing bundled OCR Python: ${python}`);
  }
  run(
    python,
    [
      "-c",
      "import importlib.metadata, platform, paddle, paddleocr; assert platform.machine() == 'arm64'; assert paddle.__version__ == '3.3.1'; assert importlib.metadata.version('paddleocr') == '3.7.0'; print('Paddle OCR CPU runtime ok')",
    ],
    {
      timeout: 120_000,
      env: {
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPYCACHEPREFIX: join(
          tmpdir(),
          "mgt-paddle-package-verify-pycache",
        ),
        PADDLE_PDX_CACHE_HOME: join(tmpdir(), "mgt-paddle-package-verify"),
      },
    },
  );

  const ffmpeg = join(toolsDir, "ffmpeg", "ffmpeg");
  run(ffmpeg, ["-version"], { timeout: 30_000 });

  const runner = join(
    toolsDir,
    "mgt-koharu-inpaint-runner",
    "mgt-koharu-inpaint-runner",
  );
  if (!existsSync(runner)) {
    throw new Error(`Missing bundled Metal inpainting runner: ${runner}`);
  }
  const capabilities = run(runner, ["--capabilities"], { timeout: 60_000 });
  const capabilityText = capabilities.stdout.trim();
  if (
    !/metal/i.test(capabilityText) ||
    !/lama-manga/i.test(capabilityText) ||
    !/aot-inpainting/i.test(capabilityText)
  ) {
    throw new Error(
      `Incomplete Metal inpainting capabilities: ${capabilityText}`,
    );
  }
  const fluxRunner = join(toolsDir, "mgt-flux-klein", "mgt-flux-klein");
  if (!existsSync(fluxRunner)) {
    throw new Error(`Missing bundled Flux Metal runner: ${fluxRunner}`);
  }
  const fluxCapabilities = run(fluxRunner, ["--capabilities"], {
    timeout: 60_000,
  }).stdout.trim();
  if (
    !/metal/i.test(fluxCapabilities) ||
    !/flux-klein/i.test(fluxCapabilities)
  ) {
    throw new Error(`Incomplete Flux Metal capabilities: ${fluxCapabilities}`);
  }
  const protocolSmoke = run(fluxRunner, ["--protocol-smoke"], {
    input: `${JSON.stringify({ type: "shutdown" })}\n`,
    timeout: 60_000,
  }).stdout.trim();
  const protocolResult = JSON.parse(protocolSmoke);
  if (
    protocolResult.ok !== true ||
    protocolResult.protocol_version !== 1 ||
    protocolResult.request !== "shutdown" ||
    protocolResult.backend !== "metal-native"
  ) {
    throw new Error(`Flux worker protocol smoke failed: ${protocolSmoke}`);
  }
}

/** @param {string} appPath */
function verifyPackagedTarRuntime(appPath) {
  const appExecutable = join(
    appPath,
    "Contents",
    "MacOS",
    "CarrotMangaTranslator",
  );
  const tarRuntimePath = join(
    appPath,
    "Contents",
    "Resources",
    "app-runtime",
    "simple-page-tar-utils.cjs",
  );
  if (!existsSync(tarRuntimePath)) {
    throw new Error(`Packaged tar runtime is missing: ${tarRuntimePath}`);
  }
  const smokeScript = [
    `const runtime = require(${JSON.stringify(tarRuntimePath)});`,
    "if (typeof runtime.extractSelectedTarEntries !== 'function') throw new Error('Packaged tar runtime did not load');",
    "console.log('packaged-tar-runtime-ok');",
  ].join("\n");
  run(appExecutable, ["-e", smokeScript], {
    env: { ELECTRON_RUN_AS_NODE: "1" },
    timeout: 30_000,
  });
}

/** @param {string} appPath */
function verifyPackagedBuildChannel(appPath) {
  const appExecutable = join(
    appPath,
    "Contents",
    "MacOS",
    "CarrotMangaTranslator",
  );
  const packageJsonPath = join(
    appPath,
    "Contents",
    "Resources",
    "app.asar",
    "package.json",
  );
  const expectedChannel = resolveMacPackageChannel();
  const smokeScript = [
    'const { readFileSync } = require("node:fs");',
    `const metadata = JSON.parse(readFileSync(${JSON.stringify(packageJsonPath)}, "utf8"));`,
    `if (metadata.buildChannel !== ${JSON.stringify(expectedChannel)}) throw new Error("Unexpected packaged build channel: " + String(metadata.buildChannel));`,
    'console.log("packaged-build-channel-ok", metadata.buildChannel);',
  ].join("\n");
  run(appExecutable, ["-e", smokeScript], {
    env: { ELECTRON_RUN_AS_NODE: "1" },
    timeout: 30_000,
  });
}

/** @param {string} appPath */
function verifySigning(appPath) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const details = run("codesign", ["-dvvv", appPath]).stderr;
  const entitlementsResult = run("codesign", [
    "-d",
    "--entitlements",
    ":-",
    appPath,
  ]);
  const entitlements = `${entitlementsResult.stdout}\n${entitlementsResult.stderr}`;
  if (!/com\.apple\.security\.cs\.allow-jit/m.test(entitlements)) {
    throw new Error(
      `Signed app is missing the Electron JIT entitlement:\n${entitlements}`,
    );
  }
  if (process.env.MGT_MAC_SIGNING_MODE === "developer-id") {
    if (!/Authority=Developer ID Application/m.test(details)) {
      throw new Error(`Expected Developer ID signature, got:\n${details}`);
    }
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    run("xcrun", ["stapler", "validate", appPath]);
  } else if (!/Signature=adhoc/m.test(details)) {
    throw new Error(`Expected ad-hoc signature, got:\n${details}`);
  }
}

/** @param {string} diskImagePath */
function verifyFinalDiskImage(diskImagePath) {
  const mountRoot = mkdtempSync(join(tmpdir(), "mgt-final-dmg-"));
  let attachedDevice = "";
  try {
    const attach = createDiskImageAttachCommand(diskImagePath, mountRoot);
    const attachResult = run(attach.command, attach.args, attach.options);
    /** @type {{ "system-entities"?: Array<Record<string, unknown>> }} */
    const attachJson = JSON.parse(
      run("plutil", ["-convert", "json", "-o", "-", "-"], {
        input: attachResult.stdout,
      }).stdout,
    );
    const mountedEntity = attachJson["system-entities"]?.find(
      (entity) => entity["mount-point"] && entity["dev-entry"],
    );
    attachedDevice = String(mountedEntity?.["dev-entry"] || "");
    if (!attachedDevice) {
      throw new Error(
        `Could not resolve the mounted device for final DMG: ${diskImagePath}`,
      );
    }

    const appPath = findSingleAppBundle(mountRoot, "final DMG");
    assertElectronFrameworkExecutable(appPath);
    verifySigning(appPath);
    verifyPackagedTarRuntime(appPath);
    verifyApplicationDirectorySmoke(appPath);
    console.log(
      `[mac-verify] mounted, signed, copied, and launched final DMG app ${relative(root, appPath)}`,
    );
  } finally {
    try {
      if (attachedDevice) {
        run("hdiutil", ["detach", attachedDevice], { timeout: 120_000 });
      }
    } finally {
      rmSync(mountRoot, { recursive: true, force: true });
    }
  }
}

/** @param {string} zipPath */
function verifyFinalZipArchive(zipPath) {
  const extractRoot = mkdtempSync(join(tmpdir(), "mgt-final-zip-"));
  try {
    const extract = createZipExtractCommand(zipPath, extractRoot);
    run(extract.command, extract.args, extract.options);
    const appPath = findSingleAppBundle(extractRoot, "final ZIP");
    assertElectronFrameworkExecutable(appPath);
    verifySigning(appPath);
    verifyPackagedTarRuntime(appPath);
    console.log(
      `[mac-verify] extracted and verified final ZIP app ${relative(root, appPath)}`,
    );
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

/** @param {string} diskImagePath @param {string} mountRoot */
function createDiskImageAttachCommand(diskImagePath, mountRoot) {
  return {
    command: "hdiutil",
    args: [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountRoot,
      "-plist",
      diskImagePath,
    ],
    options: { timeout: 120_000 },
  };
}

/** @param {string} zipPath @param {string} extractRoot */
function createZipExtractCommand(zipPath, extractRoot) {
  return {
    command: "ditto",
    args: ["-x", "-k", zipPath, extractRoot],
    options: { timeout: 300_000 },
  };
}

module.exports = {
  createDiskImageAttachCommand,
  createZipExtractCommand,
  verifyFinalDiskImage,
  verifyFinalZipArchive,
  verifyNativePayload,
  verifyPackagedBuildChannel,
  verifyPackagedTarRuntime,
  verifyRequiredRuntimes,
  verifySigning,
};
