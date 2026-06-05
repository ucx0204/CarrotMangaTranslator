const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CHAPTER_DIR = path.join(
  ROOT,
  "library",
  "works",
  "81592b17-9d3c-41e8-b92e-4041a36d286a",
  "chapters",
  "ff6ff56e-d3d9-4e21-b561-715968b8572a"
);

const chapterDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CHAPTER_DIR;
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(ROOT, ".tmp", "flux-pattern-smoke", timestamp);
const sourceDir = path.join(outDir, "chapter-copy");
const sourcePagesDir = path.join(sourceDir, "pages");
const sourceInpaintedDir = path.join(sourceDir, "inpainted");

app.setPath("userData", path.join(ROOT, ".tmp", "flux-pattern-smoke", "electron-user-data"));

async function main() {
  await app.whenReady();
  const {
    inpaintPatternPage,
    prepareFluxInpaintingEngine
  } = require(path.join(ROOT, "out", "main", "inpainting.js"));

  mkdirSync(outDir, { recursive: true });
  mkdirSync(sourcePagesDir, { recursive: true });
  mkdirSync(sourceInpaintedDir, { recursive: true });

  const chapterPath = path.join(chapterDir, "chapter.json");
  const chapter = JSON.parse(readFileSync(chapterPath, "utf8"));
  const pages = chapter.pages ?? [];
  const smokePages = pages.map((page, index) => copyPageForSmoke(page, index));
  const targetPages = smokePages.filter((page) => (page.blocks ?? []).length > 0);

  const vram = startVramSampler();
  const progressLog = [];
  const startedAt = performance.now();
  console.log(`[flux-smoke] chapter=${chapter.title || chapter.id || path.basename(chapterDir)}`);
  console.log(`[flux-smoke] pages=${pages.length}, pattern-pages=${targetPages.length}, out=${outDir}`);

  if (!process.env.MGT_FLUX_KLEIN_EXE) {
    const localMgtFlux = path.join(ROOT, "tools", "mgt-flux-klein", "mgt-flux-klein.exe");
    if (existsSync(localMgtFlux)) {
      process.env.MGT_FLUX_KLEIN_EXE = localMgtFlux;
    }
  }

  const engine = await prepareFluxInpaintingEngine({
    runtimeDir: path.join(ROOT, "models", "inpainting", "mgt-flux-klein-runtime"),
    modelDir: path.join(ROOT, "models", "inpainting", "flux-klein-4b"),
    onProgress: (progress) => {
      const line = `${new Date().toISOString()} ${progress.progressText}${progress.detail ? ` - ${progress.detail}` : ""}`;
      progressLog.push(line);
      console.log(`[flux-smoke] ${line}`);
    }
  });

  const results = [];
  try {
    for (const [targetIndex, page] of targetPages.entries()) {
      const pageStartedAt = performance.now();
      const patternCount = page.blocks.length;
      console.log(`[flux-smoke] ${targetIndex + 1}/${targetPages.length} ${page.name} pattern=${patternCount}`);
      const beforeVram = vram.current();
      const result = await inpaintPatternPage(page, {
        fluxEngine: engine
      });
      const elapsedMs = performance.now() - pageStartedAt;
      const afterVram = vram.current();
      results.push({
        pageId: page.id,
        name: page.name,
        sourceImagePath: page.inpaintedImagePath || page.imagePath,
        outputImagePath: result.page.inpaintedImagePath,
        blocksTotal: page.blocks.length,
        patternBlocks: patternCount,
        blocksErased: result.blocksErased,
        elapsedMs,
        beforeVram,
        afterVram
      });
      console.log(
        `[flux-smoke] done ${page.name} erased=${result.blocksErased} elapsed=${formatSeconds(elapsedMs)} peakFlux=${vram.peakProcessMiB}MiB peakDelta=${vram.peakDeltaMiB()}MiB`
      );
    }
  } finally {
    await engine.dispose();
    vram.stop();
  }

  const totalElapsedMs = performance.now() - startedAt;
  const summary = {
    chapterDir,
    chapterTitle: chapter.title,
    outputDir: outDir,
    startedAt: new Date(Date.now() - totalElapsedMs).toISOString(),
    completedAt: new Date().toISOString(),
    pages: pages.length,
    patternPages: targetPages.length,
    totalPatternBlocks: targetPages.reduce((sum, page) => sum + page.blocks.length, 0),
    totalErasedBlocks: results.reduce((sum, result) => sum + result.blocksErased, 0),
    totalElapsedMs,
    averagePageMs: results.length ? totalElapsedMs / results.length : 0,
    vram: {
      baselineTotalMiB: vram.baselineTotalMiB,
      peakTotalMiB: vram.peakTotalMiB,
      peakDeltaMiB: vram.peakDeltaMiB(),
      peakFluxProcessMiB: vram.peakProcessMiB,
      samples: vram.samples.length
    },
    results
  };

  writeFileSync(path.join(outDir, "progress.log"), progressLog.join("\n"), "utf8");
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(summary, null, 2), "utf8");
  await writeHtmlReport(summary);
  await writeContactSheet(summary);
  console.log(`[flux-smoke] wrote ${outDir}`);
  console.log(`[flux-smoke] total=${formatSeconds(totalElapsedMs)} avg=${formatSeconds(summary.averagePageMs)} peakFlux=${summary.vram.peakFluxProcessMiB}MiB peakDelta=${summary.vram.peakDeltaMiB}MiB`);
  app.quit();
}

function copyPageForSmoke(page, index) {
  const sourceImage = page.imagePath;
  const copiedImage = path.join(sourcePagesDir, `${String(index + 1).padStart(3, "0")}-${path.basename(sourceImage)}`);
  copyFileSync(sourceImage, copiedImage);
  let copiedInpainted;
  if (page.inpaintedImagePath && existsSync(page.inpaintedImagePath)) {
    copiedInpainted = path.join(sourceInpaintedDir, `${String(index + 1).padStart(3, "0")}-${path.basename(page.inpaintedImagePath)}`);
    copyFileSync(page.inpaintedImagePath, copiedInpainted);
  }
  return {
    ...page,
    imagePath: copiedImage,
    inpaintedImagePath: copiedInpainted
  };
}

function startVramSampler() {
  const samples = [];
  const baseline = readVramSample();
  const state = {
    samples,
    baselineTotalMiB: baseline.totalMiB,
    peakTotalMiB: baseline.totalMiB,
    peakProcessMiB: baseline.fluxProcessMiB,
    current: () => readVramSample(),
    peakDeltaMiB: () => Math.max(0, state.peakTotalMiB - state.baselineTotalMiB),
    stop: () => clearInterval(timer)
  };
  const timer = setInterval(() => {
    const sample = readVramSample();
    samples.push(sample);
    state.peakTotalMiB = Math.max(state.peakTotalMiB, sample.totalMiB);
    state.peakProcessMiB = Math.max(state.peakProcessMiB, sample.fluxProcessMiB);
  }, 500);
  return state;
}

function readVramSample() {
  const sample = {
    at: Date.now(),
    totalMiB: 0,
    fluxProcessMiB: 0
  };
  try {
    const total = execFileSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2500
    })
      .trim()
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter(Number.isFinite);
    sample.totalMiB = total.reduce((sum, value) => sum + value, 0);
  } catch {
    sample.totalMiB = 0;
  }
  try {
    const apps = execFileSync("nvidia-smi", ["--query-compute-apps=pid,process_name,used_gpu_memory", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2500
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    for (const line of apps) {
      const parts = line.split(",").map((part) => part.trim());
      const processName = parts[1] || "";
      const used = Number.parseInt(parts[2] || "0", 10);
      if (/mgt-flux-klein|electron/i.test(processName) && Number.isFinite(used)) {
        sample.fluxProcessMiB += used;
      }
    }
  } catch {
    sample.fluxProcessMiB = 0;
  }
  return sample;
}

async function writeHtmlReport(summary) {
  const rows = summary.results
    .map((result) => {
      const source = pathToFileURL(result.sourceImagePath).href;
      const output = result.outputImagePath ? pathToFileURL(result.outputImagePath).href : "";
      return `<section class="row">
        <header><strong>${escapeHtml(result.name)}</strong><span>${result.patternBlocks} blocks · erased ${result.blocksErased} · ${formatSeconds(result.elapsedMs)}</span></header>
        <div class="pair">
          <figure><figcaption>before</figcaption><img src="${source}"></figure>
          <figure><figcaption>after</figcaption><img src="${output}"></figure>
        </div>
      </section>`;
    })
    .join("\n");
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Flux Pattern Smoke</title>
<style>
body{margin:0;background:#101317;color:#f3eee6;font-family:Segoe UI,Malgun Gothic,sans-serif;padding:24px}
h1{margin:0 0 8px;font-size:24px}
.meta{color:#c8c0b6;margin-bottom:20px;line-height:1.5}
.row{border:1px solid #2e3743;border-radius:12px;background:#171c22;margin:0 0 18px;padding:14px}
header{display:flex;justify-content:space-between;gap:16px;margin-bottom:10px}
header span{color:#bdb4a8}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
figure{margin:0}
figcaption{font-size:12px;color:#95a2b5;margin-bottom:5px}
img{max-width:100%;background:#0b0d10;border:1px solid #313b47;border-radius:8px}
</style>
<h1>Flux Pattern Smoke</h1>
<div class="meta">
  ${escapeHtml(summary.chapterTitle || "chapter")}<br>
  ${summary.patternPages} pattern pages · ${summary.totalPatternBlocks} pattern blocks · total ${formatSeconds(summary.totalElapsedMs)} · avg ${formatSeconds(summary.averagePageMs)}<br>
  VRAM baseline ${summary.vram.baselineTotalMiB} MiB · peak total ${summary.vram.peakTotalMiB} MiB · delta ${summary.vram.peakDeltaMiB} MiB · peak process ${summary.vram.peakFluxProcessMiB} MiB
</div>
${rows}`;
  writeFileSync(path.join(outDir, "report.html"), html, "utf8");
}

async function writeContactSheet(summary) {
  if (summary.results.length === 0) {
    return;
  }
  const rowHeight = 420;
  const width = 1200;
  const height = Math.max(rowHeight, summary.results.length * rowHeight);
  const htmlPath = path.join(outDir, "report.html");
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { offscreen: true }
  });
  await window.loadFile(htmlPath);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
  writeFileSync(path.join(outDir, "contact-sheet.png"), image.toPNG());
  window.destroy();
}

function formatSeconds(ms) {
  if (!Number.isFinite(ms)) {
    return "0.0s";
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
