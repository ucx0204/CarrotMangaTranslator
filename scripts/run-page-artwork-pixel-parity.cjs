// @ts-check
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync } = require("node:fs");
const { readFile, rm } = require("node:fs/promises");
const { isAbsolute, join, relative, resolve } = require("node:path");
const { ensureElectronExecutable } = require("./electron-executable.cjs");

const root = join(__dirname, "..");
const runRoot = join(
  root,
  ".tmp",
  "page-artwork-pixel-parity",
  `${process.pid}-${Date.now()}`,
);
const bundleDir = join(runRoot, "panel-bundle");
const artifactDir = join(runRoot, "artifacts");
const resultPath = join(runRoot, "result.json");
const runnerPath = join(
  root,
  "scripts",
  "page-artwork-pixel-parity",
  "electron-runner.cjs",
);
const keepArtifacts = process.argv.includes("--keep-artifacts");
const useHardwareAcceleration = process.argv.includes("--hardware");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  assertBuildInputs();
  assertPathInsideRoot(runRoot);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  let succeeded = false;
  try {
    await buildPanelRuntime();
    const result = runElectronComparison();
    const report = await readResult();
    printReport(report);
    if (result.error) throw result.error;
    if (result.status !== 0 || !report.ok) {
      throw new Error(
        `Page artwork pixel parity failed; artifacts: ${artifactDir}`,
      );
    }
    if (keepArtifacts) {
      console.log(`Pixel-parity artifacts kept at ${artifactDir}`);
    }
    succeeded = true;
  } finally {
    if (!keepArtifacts && succeeded) {
      await rm(runRoot, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
    }
  }
}

function assertBuildInputs() {
  const required = [
    join(root, "out", "main", "pageExport.js"),
    join(root, "out", "main", "pageExportHtml.js"),
    join(root, "out", "page-export", "runtime.js"),
    join(root, "out", "page-export", "styles.css"),
  ];
  const missing = required.filter((filePath) => !existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(
      `Page export build assets are missing:\n- ${missing.join(
        "\n- ",
      )}\nRun npm run compile:electron first.`,
    );
  }
}

async function buildPanelRuntime() {
  const [{ build }, reactModule] = await Promise.all([
    import("vite"),
    import("@vitejs/plugin-react"),
  ]);
  await build({
    configFile: false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    plugins: [reactModule.default()],
    build: {
      cssCodeSplit: false,
      emptyOutDir: true,
      lib: {
        cssFileName: "panel",
        entry: join(root, "tests", "pageArtworkPixelParityPanelEntry.tsx"),
        fileName: () => "panel.js",
        formats: ["iife"],
        name: "MangaPanelPixelParity",
      },
      minify: false,
      outDir: bundleDir,
      sourcemap: false,
      target: "es2022",
    },
  });
  const outputs = new Set(readdirSync(bundleDir));
  for (const fileName of ["panel.js", "panel.css"]) {
    if (!outputs.has(fileName)) {
      throw new Error(`Pixel-parity panel build is missing ${fileName}.`);
    }
  }
}

function runElectronComparison() {
  const electronExe = ensureElectronExecutable(root);
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    MGT_PIXEL_PARITY_ARTIFACT_DIR: artifactDir,
    MGT_PIXEL_PARITY_BUNDLE_DIR: bundleDir,
    MGT_PIXEL_PARITY_RESULT_PATH: resultPath,
    MGT_PIXEL_PARITY_RUN_ROOT: runRoot,
    MGT_PIXEL_PARITY_USER_DATA: join(runRoot, "electron-user-data"),
    MGT_PIXEL_PARITY_HARDWARE: useHardwareAcceleration ? "1" : "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronExe, [runnerPath], {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: 90_000,
    windowsHide: true,
  });
  if (result.signal) {
    throw new Error(
      `Page artwork pixel parity terminated by ${result.signal}.`,
    );
  }
  return result;
}

async function readResult() {
  try {
    const parsed = JSON.parse(await readFile(resultPath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.ok !== "boolean" ||
      !Array.isArray(parsed.cases)
    ) {
      throw new Error("Pixel-parity runner returned an invalid result.");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Pixel-parity result is unavailable; artifacts: ${artifactDir}`,
      { cause: error },
    );
  }
}

/**
 * @param {{ok: boolean; cases: Array<{
 *   id: string;
 *   exportSize: {width: number; height: number};
 *   panelSize: {width: number; height: number};
 *   mismatchedPixels?: number;
 *   maxChannelDelta?: number;
 * }>; error?: string}} report
 */
function printReport(report) {
  for (const item of report.cases) {
    const size = `${item.panelSize.width}x${item.panelSize.height}`;
    const exported = `${item.exportSize.width}x${item.exportSize.height}`;
    console.log(
      `${item.id}: panel=${size}, export=${exported}, mismatchedPixels=${
        item.mismatchedPixels ?? "dimension-mismatch"
      }, maxChannelDelta=${item.maxChannelDelta ?? "n/a"}`,
    );
  }
  if (report.error) console.error(report.error);
}

/** @param {string} targetPath */
function assertPathInsideRoot(targetPath) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(targetPath);
  const child = relative(resolvedRoot, resolvedTarget);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(
      `Refusing to use unexpected pixel-parity path: ${targetPath}`,
    );
  }
}
