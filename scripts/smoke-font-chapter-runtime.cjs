const { app } = require("electron");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { deepStrictEqual } = require("node:assert");
const { spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");

// Runs the compiled production downloader and native models. No local font
// cache is reused; a packaged ASAR can be supplied as the module root.
const moduleRoot = resolve(process.argv[2]);
const dataRoot = resolve(process.argv[3]);
const runtimeDir = resolve(process.argv[4]);
const python = process.argv[5];
const reference = resolve(process.argv[6]);
if (existsSync(dataRoot))
  throw new Error("Use a new empty font smoke data root");
mkdirSync(dataRoot, { recursive: true });
process.env.MANGA_TRANSLATOR_DATA_ROOT = dataRoot;
app.setPath("userData", join(dataRoot, "electron-profile"));
if (moduleRoot.includes("app.asar")) {
  Object.defineProperty(process, "resourcesPath", {
    value: resolve(moduleRoot, "../.."),
  });
}
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const { prepareFontChapterRuntime } = require(
      join(moduleRoot, "main/pipeline/fontChapterRuntimeAssets.js"),
    );
    let lastPercent = -1;
    const installed = await prepareFontChapterRuntime({
      paths: { dataRoot, runtimeDir },
      signal: new AbortController().signal,
      onProgress: (/** @type {{ progressPercent?: number }} */ progress) => {
        const percent = Math.floor((progress.progressPercent ?? 0) * 10) * 10;
        if (percent !== lastPercent) {
          console.log(`Font asset download ${percent}%`);
          lastPercent = percent;
        }
      },
    });
    const manifestPath = join(dataRoot, "font-runtime-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(installed.manifest));
    const probe = spawnSync(
      python,
      [
        join(__dirname, "smoke-font-chapter-native.py"),
        "--assets",
        installed.assets,
        "--runtime",
        runtimeDir,
        "--manifest",
        manifestPath,
        "--reference",
        reference,
        ...(process.argv.includes("--record") ? ["--record"] : []),
      ],
      {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" },
        encoding: "utf8",
        windowsHide: true,
        timeout: 180_000,
      },
    );
    if (probe.error || probe.status !== 0)
      throw probe.error ?? new Error(probe.stderr || probe.stdout);
    console.log(probe.stdout.trim());
    await smokeApprovedChapter();
    writeFileSync(
      join(dataRoot, "font-runtime-smoke.json"),
      JSON.stringify(
        {
          version: installed.manifest.version,
          assets: installed.assets,
          moduleRoot,
          runtimeDir,
          native: JSON.parse(probe.stdout.trim()),
          verified: true,
        },
        null,
        2,
      ),
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

async function smokeApprovedChapter() {
  const chapter = process.env.MGT_FONT_SMOKE_CHAPTER;
  const expected = process.env.MGT_FONT_SMOKE_EXPECTED;
  const ocrRuntimeDir = process.env.MGT_FONT_SMOKE_OCR_ROOT;
  if (!chapter && !expected && !ocrRuntimeDir) return;
  if (!chapter || !expected || !ocrRuntimeDir)
    throw new Error(
      "Supply the sealed chapter, expected styles and installed OCR root together",
    );
  const report = JSON.parse(
    readFileSync(join(chapter, "ocr-baseline/baseline-report.json"), "utf8"),
  );
  const entries = [];
  for (const source of report.pages) {
    const file = join(chapter, "baseline", source.pageId, "font-page.json");
    if (!existsSync(file)) continue;
    const frozen = JSON.parse(readFileSync(file, "utf8"));
    const items = [];
    for (const row of frozen.inputs) items.push(row.item);
    entries.push({
      page: frozen.page,
      items,
      pageOptions: {
        autoFontMatching: true,
        sourceLanguage: "ja",
        targetLanguage: "ko",
        ocrPipeline: "hayai",
        ocrDevice: "gpu",
        ocrGpuBackend: "cuda",
        ocrGpuCudaTag: "cu126",
      },
    });
  }
  const { getAppPaths } = require(join(moduleRoot, "main/appPaths.js"));
  const { createFontChapterC18Port } = require(
    join(moduleRoot, "main/pipeline/fontChapterC18.js"),
  );
  const port = createFontChapterC18Port({
    ...getAppPaths(),
    dataRoot,
    runtimeDir,
    ocrRuntimeDir,
  });
  const resolver = await port.prepare(entries, new AbortController().signal);
  if (!resolver) throw new Error("Chapter font matching did not run");
  const styles = [];
  for (const entry of entries)
    for (const item of entry.items)
      styles.push({
        pageId: entry.page.id,
        itemId: item.id,
        sourceText: item.sourceText,
        style: resolver(entry.page.id, item),
      });
  deepStrictEqual(styles, JSON.parse(readFileSync(expected, "utf8")).styles);
  console.log(
    JSON.stringify({
      installedChapterPort: "passed",
      pages: entries.length,
      choices: styles.length,
      expected,
    }),
  );
}
