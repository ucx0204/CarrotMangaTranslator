#!/usr/bin/env node
// @ts-check

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { basename, join, relative, resolve } = require("node:path");
const { MAC_RUNTIME_MANIFEST } = require("./mac-runtime-manifest.cjs");
const { verifyMacRuntimeSmokes } = require("./verify-mac-runtime-smokes.cjs");

const root = join(__dirname, "..");
const distDir = join(root, "dist");
const HOSTED_APP_SMOKE_WAIVER_TOKEN = "macos15-electron43-crbrowsermain-v1";
const HOSTED_APP_SMOKE_WAIVER_PATH = join(
  distDir,
  "mac-alpha-hosted-app-smoke-waiver.json",
);
const SMOKE_APP_PATH = "/Applications/CarrotMangaTranslatorAlphaSmoke.app";

/** @typedef {{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error }} CommandResult */

/** @param {string} command @param {string[]} args @param {{ env?: NodeJS.ProcessEnv; input?: string; timeout?: number }} [options] @returns {CommandResult} */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    shell: false,
    timeout: options.timeout,
  });
  const normalized = {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    ...(result.error ? { error: result.error } : {}),
  };
  if (normalized.error || normalized.status !== 0) {
    const failure = [
      normalized.error?.message,
      normalized.signal ? `signal ${normalized.signal}` : null,
      normalized.status === null ? null : `exit ${normalized.status}`,
      normalized.stderr,
      normalized.stdout,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`${command} ${args.join(" ")} failed: ${failure}`);
  }
  return normalized;
}

/** @param {string} directory @returns {string[]} */
function listFiles(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

/** @param {string} directory @returns {string[]} */
function findAppBundles(directory) {
  /** @type {string[]} */
  const apps = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.endsWith(".app")) {
      apps.push(entryPath);
    } else {
      apps.push(...findAppBundles(entryPath));
    }
  }
  return apps;
}

/** @param {string} filePath */
function looksLikeNativeBinary(filePath) {
  const metadata = lstatSync(filePath);
  return (
    (metadata.mode & 0o111) !== 0 ||
    /\.(?:dylib|so|node)$/i.test(filePath) ||
    filePath.includes(`${join("Contents", "Frameworks")}`)
  );
}

/** @param {string} filePath */
function requiresOtoolAlias(filePath) {
  return /[()]/.test(filePath);
}

/**
 * otool-classic interprets a trailing parenthesized filename segment such as
 * "Helper (GPU)" as the archive(member) syntax. Inspect the same Mach-O through
 * a parenthesis-free symlink so the tool receives an unambiguous path.
 *
 * @param {string} filePath
 */
function runOtool(filePath) {
  if (!requiresOtoolAlias(filePath)) {
    return run("otool", ["-L", filePath]);
  }
  const aliasRoot = mkdtempSync(join(tmpdir(), "mgt-otool-"));
  const aliasPath = join(aliasRoot, "native-payload");
  try {
    symlinkSync(filePath, aliasPath);
    return run("otool", ["-L", aliasPath]);
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true });
  }
}

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

/** @param {string} appPath */
function verifyApplicationDirectorySmoke(appPath) {
  const smokeApp = SMOKE_APP_PATH;
  if (resolve(smokeApp) !== SMOKE_APP_PATH) {
    throw new Error(`Unsafe smoke app path: ${smokeApp}`);
  }
  rmSync(smokeApp, { recursive: true, force: true });
  const dataRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "manga-gemma-translator",
  );
  const marker = join(dataRoot, "mac-package-smoke.json");
  /** @type {"copy" | "prepare" | "verify"} */
  let smokeStage = "copy";
  let smokeStartedAtMs = 0;
  rmSync(marker, { force: true });
  try {
    run("ditto", [appPath, smokeApp]);
    run("codesign", ["--verify", "--deep", "--strict", smokeApp]);
    smokeStage = "prepare";
    smokeStartedAtMs = Date.now();
    runApplicationSmoke(smokeApp, "prepare");
    const prepared = waitForSmokeMarker(marker, "prepared", 120_000);
    if (
      prepared.ok !== true ||
      prepared.stage !== "prepared" ||
      prepared.imported !== true ||
      prepared.saved !== true ||
      prepared.exported !== true
    ) {
      throw new Error(
        `Invalid packaged prepare smoke result: ${JSON.stringify(prepared)}`,
      );
    }
    smokeStage = "verify";
    runApplicationSmoke(smokeApp, "verify");
    const smoke = waitForSmokeMarker(marker, "verified", 120_000);
    if (
      smoke.ok !== true ||
      smoke.stage !== "verified" ||
      smoke.platform !== "darwin" ||
      smoke.arch !== "arm64" ||
      smoke.imported !== true ||
      smoke.saved !== true ||
      smoke.restarted !== true ||
      smoke.exported !== true ||
      !String(smoke.dataRoot || "").includes(
        `${join("Library", "Application Support", "manga-gemma-translator")}`,
      ) ||
      String(smoke.dataRoot || "").startsWith("/Applications/")
    ) {
      throw new Error(
        `Invalid packaged data root smoke result: ${JSON.stringify(smoke)}`,
      );
    }
    run("codesign", ["--verify", "--deep", "--strict", smokeApp]);
  } catch (error) {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    const diagnostics = collectApplicationSmokeDiagnostics(dataRoot, marker);
    const crashReport = findFreshApplicationCrashReport(smokeStartedAtMs);
    if (
      shouldAllowHostedGuiSmokeFailure({
        stage: smokeStage,
        markerExists: existsSync(marker),
        message,
        smokeStartedAtMs,
        crashReport,
      })
    ) {
      writeHostedAppSmokeWaiver(crashReport);
      console.warn(
        `[mac-verify] Hosted runner packaged GUI lifecycle smoke hit the known pre-ready Electron SIGTRAP. Continuing this explicitly opted-in Alpha build; real-Mac launch remains unverified.\n${message}\n${diagnostics}`,
      );
      return;
    }
    throw new Error(`${message}\n${diagnostics}`, { cause: error });
  } finally {
    rmSync(smokeApp, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
}

/**
 * @typedef {{
 *   path: string;
 *   mtimeMs: number;
 *   procPath: string;
 *   exceptionType: string;
 *   signal: string;
 *   faultingThread: number;
 *   triggered: boolean;
 *   threadName: string;
 * }} ApplicationCrashReport
 */

/**
 * @param {number} smokeStartedAtMs
 * @returns {ApplicationCrashReport | null}
 */
function findFreshApplicationCrashReport(smokeStartedAtMs) {
  if (!Number.isFinite(smokeStartedAtMs) || smokeStartedAtMs <= 0) {
    return null;
  }
  const reportsDir = join(homedir(), "Library", "Logs", "DiagnosticReports");
  try {
    const reportPaths = readdirSync(reportsDir)
      .filter(
        (name) =>
          /CarrotMangaTranslator|당근망가번역기/i.test(name) &&
          name.endsWith(".ips"),
      )
      .map((name) => join(reportsDir, name))
      .filter(
        (reportPath) =>
          statSync(reportPath).mtimeMs >= smokeStartedAtMs - 5_000,
      )
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const reportPath of reportPaths) {
      const contents = readFileSync(reportPath, "utf8").replace(/^\uFEFF/, "");
      const firstLineEnd = contents.indexOf("\n");
      if (firstLineEnd < 0) continue;
      /** @type {Record<string, any>} */
      const report = JSON.parse(contents.slice(firstLineEnd + 1));
      const faultingThread = Number(report.faultingThread);
      const thread = Array.isArray(report.threads)
        ? report.threads[faultingThread]
        : undefined;
      return {
        path: reportPath,
        mtimeMs: statSync(reportPath).mtimeMs,
        procPath: String(report.procPath || ""),
        exceptionType: String(report.exception?.type || ""),
        signal: String(report.exception?.signal || ""),
        faultingThread,
        triggered: thread?.triggered === true,
        threadName: String(thread?.name || ""),
      };
    }
  } catch (_error) {
    return null;
  }
  return null;
}

/**
 * Alpha CI may downgrade only the exact, fresh pre-marker native crash observed
 * on GitHub-hosted macOS 15 arm64 with Electron 43. Every other smoke failure
 * remains release-blocking.
 *
 * @param {{
 *   stage: "copy" | "prepare" | "verify";
 *   markerExists: boolean;
 *   message: string;
 *   smokeStartedAtMs: number;
 *   crashReport: ApplicationCrashReport | null;
 * }} input
 * @param {NodeJS.ProcessEnv} [environment]
 */
function shouldAllowHostedGuiSmokeFailure(input, environment = process.env) {
  const report = input.crashReport;
  return (
    environment.MGT_MAC_ALPHA_ALLOW_HOSTED_APP_SMOKE_TRAP ===
      HOSTED_APP_SMOKE_WAIVER_TOKEN &&
    environment.MGT_MAC_ALPHA_RUNNER_ENVIRONMENT === "github-hosted" &&
    environment.GITHUB_ACTIONS === "true" &&
    environment.RUNNER_OS === "macOS" &&
    environment.RUNNER_ARCH === "ARM64" &&
    environment.GITHUB_REF === "refs/heads/master" &&
    /\.github\/workflows\/mac-alpha\.yml@refs\/heads\/master$/.test(
      String(environment.GITHUB_WORKFLOW_REF || ""),
    ) &&
    input.stage === "prepare" &&
    input.markerExists === false &&
    /Timed out waiting for packaged app smoke stage prepared/.test(
      input.message,
    ) &&
    report !== null &&
    report.mtimeMs >= input.smokeStartedAtMs - 5_000 &&
    report.procPath ===
      `${SMOKE_APP_PATH}/Contents/MacOS/CarrotMangaTranslator` &&
    report.exceptionType === "EXC_BREAKPOINT" &&
    report.signal === "SIGTRAP" &&
    report.faultingThread === 0 &&
    report.triggered === true &&
    report.threadName === "CrBrowserMain"
  );
}

/** @param {ApplicationCrashReport | null} report */
function writeHostedAppSmokeWaiver(report) {
  if (!report) throw new Error("Hosted app smoke waiver report is missing.");
  writeFileSync(
    HOSTED_APP_SMOKE_WAIVER_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        stage: "prepare",
        reason: HOSTED_APP_SMOKE_WAIVER_TOKEN,
        exception: report.exceptionType,
        signal: report.signal,
        thread: report.threadName,
        runner: "github-hosted-macos-arm64",
        runId: process.env.GITHUB_RUN_ID || "unknown",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** @param {string} smokeApp @param {"prepare" | "verify"} stage */
function runApplicationSmoke(smokeApp, stage) {
  run(
    "open",
    [
      "-W",
      "-n",
      "-F",
      "-g",
      smokeApp,
      "--args",
      "--mgt-mac-package-smoke=alpha-ci-v1",
      `--mgt-mac-package-smoke-stage=${stage}`,
      "--disable-gpu",
      "--enable-logging=stderr",
      "--v=1",
    ],
    { timeout: 120_000 },
  );
}

/**
 * LaunchServices can return before the new process has flushed its marker on
 * hosted runners. Wait for the exact stage instead of racing the app startup.
 *
 * @param {string} marker
 * @param {"prepared" | "verified"} expectedStage
 * @param {number} timeoutMs
 * @returns {Record<string, unknown>}
 */
function waitForSmokeMarker(marker, expectedStage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "marker missing";
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(marker, "utf8"));
      } catch (error) {
        lastState = `marker unreadable: ${error instanceof Error ? error.message : String(error)}`;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        continue;
      }
      if (parsed?.ok === false) {
        throw new Error(
          `Packaged app smoke reported failure: ${JSON.stringify(parsed)}`,
        );
      }
      if (parsed?.stage === expectedStage) {
        return parsed;
      }
      lastState = `marker stage ${String(parsed?.stage || "unknown")} phase ${String(parsed?.phase || "unknown")}`;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(
    `Timed out waiting for packaged app smoke stage ${expectedStage}: ${lastState}: ${marker}`,
  );
}

/** @param {string} dataRoot @param {string} marker */
function collectApplicationSmokeDiagnostics(dataRoot, marker) {
  /** @type {string[]} */
  const diagnostics = [];
  appendDiagnosticFile(diagnostics, "smoke marker", marker);
  appendDiagnosticFile(
    diagnostics,
    "application log",
    join(dataRoot, "logs", "app.log"),
  );
  appendDiagnosticFile(
    diagnostics,
    "bootstrap log",
    join(dataRoot, "logs", "bootstrap.log"),
  );

  const reportsDir = join(homedir(), "Library", "Logs", "DiagnosticReports");
  try {
    const reports = readdirSync(reportsDir)
      .filter(
        (name) =>
          /CarrotMangaTranslator|당근망가번역기/i.test(name) &&
          /\.(?:crash|ips)$/i.test(name),
      )
      .map((name) => join(reportsDir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    if (reports[0]) {
      appendDiagnosticFile(
        diagnostics,
        "latest macOS crash report",
        reports[0],
      );
    }
  } catch (error) {
    diagnostics.push(
      `[mac-smoke diagnostics] Could not inspect crash reports: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return diagnostics.length > 0
    ? diagnostics.join("\n")
    : "[mac-smoke diagnostics] No marker, app log, or crash report was produced.";
}

/** @param {string[]} diagnostics @param {string} label @param {string} filePath */
function appendDiagnosticFile(diagnostics, label, filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  try {
    const contents = readFileSync(filePath, "utf8");
    const diagnosticLimit = 32 * 1024;
    const excerpt =
      contents.length <= diagnosticLimit
        ? contents
        : `${contents.slice(0, 20 * 1024)}\n[mac-smoke diagnostics] ... middle omitted ...\n${contents.slice(-12 * 1024)}`;
    diagnostics.push(
      `[mac-smoke diagnostics] ${label}: ${filePath}\n${excerpt}`,
    );
  } catch (error) {
    diagnostics.push(
      `[mac-smoke diagnostics] Could not read ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** @param {string} filePath @returns {Promise<string>} */
async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS package verification requires macOS arm64.");
  }
  rmSync(HOSTED_APP_SMOKE_WAIVER_PATH, { force: true });
  const apps = findAppBundles(distDir);
  if (apps.length !== 1) {
    throw new Error(`Expected one unpacked .app in dist, found ${apps.length}`);
  }
  const appPath = apps[0];
  verifyNativePayload(appPath);
  // Establish that electron-builder produced a valid sealed bundle before
  // running any executable from it.  The second check below proves that the
  // runtime smokes kept the signed .app immutable.
  verifySigning(appPath);
  // Launch through LaunchServices exactly as a user opens an installed .app,
  // before the memory-intensive OCR and Metal model smokes run.
  verifyApplicationDirectorySmoke(appPath);
  verifyRequiredRuntimes(appPath);
  await verifyMacRuntimeSmokes({ appPath });
  verifySigning(appPath);

  const dmgFiles = listFiles(distDir).filter((filePath) =>
    filePath.endsWith(".dmg"),
  );
  const zipFiles = listFiles(distDir).filter((filePath) =>
    filePath.endsWith(".zip"),
  );
  if (dmgFiles.length !== 1 || zipFiles.length !== 1) {
    throw new Error(
      `Expected one arm64 DMG and ZIP, found DMG=${dmgFiles.length} ZIP=${zipFiles.length}`,
    );
  }
  run("hdiutil", ["verify", dmgFiles[0]], { timeout: 120_000 });
  if (process.env.MGT_MAC_SIGNING_MODE === "developer-id") {
    run("xcrun", ["stapler", "validate", dmgFiles[0]]);
  }

  const artifacts = [...dmgFiles, ...zipFiles];
  const sums = (
    await Promise.all(
      artifacts.map(
        async (filePath) => `${await sha256(filePath)}  ${basename(filePath)}`,
      ),
    )
  ).join("\n");
  const checksumPath = join(distDir, "SHA256SUMS-mac-alpha.txt");
  writeFileSync(checksumPath, `${sums}\n`, "utf8");
  console.log(
    `[mac-verify] verified ${relative(root, appPath)} and wrote ${relative(root, checksumPath)}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  findAppBundles,
  listFiles,
  looksLikeNativeBinary,
  requiresOtoolAlias,
  shouldAllowHostedGuiSmokeFailure,
};
