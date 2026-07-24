const {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");
const { run } = require("./core.cjs");
const root = join(__dirname, "..", "..");
const distDir = join(root, "dist");
const HOSTED_APP_SMOKE_WAIVER_TOKEN = "macos15-electron43-crbrowsermain-v1";
const HOSTED_APP_SMOKE_WAIVER_PATH = join(
  distDir,
  "mac-alpha-hosted-app-smoke-waiver.json",
);
const SMOKE_APP_PATH = "/Applications/CarrotMangaTranslatorAlphaSmoke.app";

/** @param {string} appPath */
function verifyApplicationDirectorySmoke(appPath) {
  const smokeApp = SMOKE_APP_PATH;
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
  prepareSmokeApp(appPath, smokeApp, marker);
  try {
    smokeStage = "prepare";
    smokeStartedAtMs = Date.now();
    runApplicationSmoke(smokeApp, "prepare");
    assertPreparedSmoke(waitForSmokeMarker(marker, "prepared", 120_000));
    smokeStage = "verify";
    runApplicationSmoke(smokeApp, "verify");
    assertVerifiedSmoke(waitForSmokeMarker(marker, "verified", 120_000));
    run("codesign", ["--verify", "--deep", "--strict", smokeApp]);
  } catch (error) {
    handleSmokeFailure(error, {
      dataRoot,
      marker,
      smokeStage,
      smokeStartedAtMs,
    });
  } finally {
    rmSync(smokeApp, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
}

/** @param {string} appPath @param {string} smokeApp @param {string} marker */
function prepareSmokeApp(appPath, smokeApp, marker) {
  if (resolve(smokeApp) !== SMOKE_APP_PATH) {
    throw new Error(`Unsafe smoke app path: ${smokeApp}`);
  }
  rmSync(smokeApp, { recursive: true, force: true });
  rmSync(marker, { force: true });
  run("ditto", [appPath, smokeApp]);
  run("codesign", ["--verify", "--deep", "--strict", smokeApp]);
}

/** @param {Record<string, any>} prepared */
function assertPreparedSmoke(prepared) {
  const valid = [
    prepared.ok === true,
    prepared.stage === "prepared",
    prepared.imported === true,
    prepared.saved === true,
    prepared.exported === true,
  ].every(Boolean);
  if (!valid) {
    throw new Error(
      `Invalid packaged prepare smoke result: ${JSON.stringify(prepared)}`,
    );
  }
}

/** @param {Record<string, any>} smoke */
function assertVerifiedSmoke(smoke) {
  const dataRoot = String(smoke.dataRoot || "");
  const valid = [
    smoke.ok === true,
    smoke.stage === "verified",
    smoke.platform === "darwin",
    smoke.arch === "arm64",
    smoke.imported === true,
    smoke.saved === true,
    smoke.restarted === true,
    smoke.exported === true,
    dataRoot.includes(
      join("Library", "Application Support", "manga-gemma-translator"),
    ),
    !dataRoot.startsWith("/Applications/"),
  ].every(Boolean);
  if (!valid) {
    throw new Error(
      `Invalid packaged data root smoke result: ${JSON.stringify(smoke)}`,
    );
  }
}

/** @param {unknown} error @param {{ dataRoot: string; marker: string; smokeStage: "copy" | "prepare" | "verify"; smokeStartedAtMs: number }} state */
function handleSmokeFailure(error, state) {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  const diagnostics = collectApplicationSmokeDiagnostics(
    state.dataRoot,
    state.marker,
  );
  const crashReport = findFreshApplicationCrashReport(state.smokeStartedAtMs);
  const waiverInput = {
    stage: state.smokeStage,
    markerExists: existsSync(state.marker),
    message,
    smokeStartedAtMs: state.smokeStartedAtMs,
    crashReport,
  };
  if (!shouldAllowHostedGuiSmokeFailure(waiverInput)) {
    throw new Error(`${message}\n${diagnostics}`, { cause: error });
  }
  writeHostedAppSmokeWaiver(crashReport);
  console.warn(
    `[mac-verify] Hosted runner packaged GUI lifecycle smoke hit the known pre-ready Electron SIGTRAP. Continuing this explicitly opted-in Alpha build; real-Mac launch remains unverified.\n${message}\n${diagnostics}`,
  );
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
  const environmentMatches = [
    environment.MGT_MAC_ALPHA_ALLOW_HOSTED_APP_SMOKE_TRAP ===
      HOSTED_APP_SMOKE_WAIVER_TOKEN &&
      environment.MGT_MAC_ALPHA_RUNNER_ENVIRONMENT === "github-hosted",
    environment.GITHUB_ACTIONS === "true",
    environment.RUNNER_OS === "macOS",
    environment.RUNNER_ARCH === "ARM64",
    environment.GITHUB_REF === "refs/heads/master",
    /\.github\/workflows\/mac-alpha\.yml@refs\/heads\/master$/.test(
      String(environment.GITHUB_WORKFLOW_REF || ""),
    ),
  ].every(Boolean);
  const failureMatches = [
    input.stage === "prepare",
    input.markerExists === false,
    /Timed out waiting for packaged app smoke stage prepared/.test(
      input.message,
    ),
  ].every(Boolean);
  const reportMatches =
    report !== null &&
    [
      report.mtimeMs >= input.smokeStartedAtMs - 5_000,
      report.procPath ===
        `${SMOKE_APP_PATH}/Contents/MacOS/CarrotMangaTranslator` &&
        report.exceptionType === "EXC_BREAKPOINT",
      report.signal === "SIGTRAP",
      report.faultingThread === 0,
      report.triggered === true,
      report.threadName === "CrBrowserMain",
    ].every(Boolean);
  return environmentMatches && failureMatches && reportMatches;
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
  const launch = createApplicationSmokeLaunch(smokeApp, stage);
  run(launch.command, launch.args, launch.options);
}

/** @param {string} smokeApp @param {"prepare" | "verify"} stage */
function createApplicationSmokeLaunch(smokeApp, stage) {
  return {
    command: "open",
    args: [
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
    options: { timeout: 120_000 },
  };
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
    const excerpt = createDiagnosticExcerpt(contents);
    diagnostics.push(
      `[mac-smoke diagnostics] ${label}: ${filePath}\n${excerpt}`,
    );
  } catch (error) {
    diagnostics.push(
      `[mac-smoke diagnostics] Could not read ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** @param {string} contents */
function createDiagnosticExcerpt(contents) {
  const diagnosticLimit = 32 * 1024;
  return contents.length <= diagnosticLimit
    ? contents
    : `${contents.slice(0, 20 * 1024)}\n[mac-smoke diagnostics] ... middle omitted ...\n${contents.slice(-12 * 1024)}`;
}

module.exports = {
  assertPreparedSmoke,
  assertVerifiedSmoke,
  createApplicationSmokeLaunch,
  createDiagnosticExcerpt,
  shouldAllowHostedGuiSmokeFailure,
  verifyApplicationDirectorySmoke,
};
