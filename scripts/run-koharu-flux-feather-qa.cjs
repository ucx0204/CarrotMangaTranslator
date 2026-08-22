/* eslint-disable @typescript-eslint/ban-ts-comment -- runtime artifact JSON and compiled module boundaries are validated here */
// @ts-nocheck -- isolated visual QA bridges compiled production modules and validated artifact JSON.
const { spawnSync } = require("node:child_process");
const electron = require("electron");
const { app, BrowserWindow, nativeImage } =
  typeof electron === "string" ? {} : electron;
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_COHORT = path.join(
  ROOT,
  "artifacts",
  "koharu-bubble-text-overlay-300-v1",
  "cohort.json",
);
const DEFAULT_ONNX = path.join(
  ROOT,
  ".tmp",
  "koharu-layout-rfdetr-onnx-v1",
  "rfdetr-seg-2xlarge.onnx",
);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertAbsentDirectory(options.outputDir);
  app.setPath("userData", path.join(options.outputDir, ".electron-profile"));
  await app.whenReady();
  const modules = loadCompiledModules();
  stageKoharuModel(options.dataRoot, options.onnxPath);
  mkdirSync(path.join(options.outputDir, "source"), { recursive: true });
  mkdirSync(path.join(options.outputDir, "masks"), { recursive: true });

  const cohort = JSON.parse(readFileSync(options.cohortPath, "utf8"));
  const entries = options.indices.map((index) => {
    const entry = cohort[index - 1];
    if (!entry) throw new Error(`Cohort index is out of range: ${index}`);
    return { ...entry, index };
  });
  const gpu = await modules.gpuInfo.detectBestGpuInfo();
  const nvidiaComputeCapability =
    gpu?.vendor === "nvidia" ? gpu.computeCapability : null;
  const engines = await prepareQaEngines({
    modules,
    nvidiaComputeCapability,
    options,
  });
  const runner = modules.bubbleLayout.createProductionBubbleLayoutRunner({
    dataRoot: options.dataRoot,
  });
  const results = [];
  try {
    for (const [position, entry] of entries.entries()) {
      console.log(
        `[koharu-flux-qa] ${position + 1}/${entries.length} cohort=${entry.index} ${entry.pageName}`,
      );
      results.push(
        await processEntry({
          entry,
          engines,
          modules,
          options,
          runner,
        }),
      );
    }
  } finally {
    await Promise.all(engines.map((engine) => engine.dispose()));
  }
  const report = {
    schemaVersion: "koharu-flux-typography-feather-qa-v1",
    status: "completed",
    productionMutation: false,
    modelInput: "broad bubble/OCR region with 160px context",
    finalComposite:
      "Koharu text+onomatopoeia mask, ratio-scaled opaque dilation core, ratio-scaled outward feather",
    indices: options.indices,
    engines: engines.map((engine) => engine.model),
    gpu,
    results,
  };
  writeFileSync(
    path.join(options.outputDir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await writeGallery(options.outputDir, report);
  console.log(`[koharu-flux-qa] wrote ${options.outputDir}`);
  app.quit();
}

async function prepareQaEngines({ modules, nvidiaComputeCapability, options }) {
  const engines = [];
  for (const model of options.engines) {
    engines.push(
      model === "flux-klein"
        ? await prepareQaFluxEngine({
            modules,
            nvidiaComputeCapability,
            options,
          })
        : await prepareQaKoharuEngine({ model, modules, options }),
    );
  }
  return engines;
}

function qaProgress(progress) {
  console.log(
    `[koharu-flux-qa] ${progress.progressText}${progress.detail ? ` - ${progress.detail}` : ""}`,
  );
}

function prepareQaFluxEngine({ modules, nvidiaComputeCapability, options }) {
  return modules.inpainting.prepareFluxInpaintingEngine({
    runtimeDir: path.join(
      ROOT,
      "models",
      "inpainting",
      "mgt-flux-klein-runtime",
    ),
    modelDir: path.join(ROOT, "models", "inpainting", "flux-klein-4b"),
    nvidiaComputeCapability,
    runRootDir: path.join(options.outputDir, ".flux-runtime"),
    onProgress: qaProgress,
  });
}

function prepareQaKoharuEngine({ model, modules, options }) {
  return modules.inpainting.prepareKoharuInpaintingEngine({
    backend: "cuda-native",
    cudaRuntimeDir: path.join(
      ROOT,
      "models",
      "inpainting",
      "mgt-flux-klein-runtime",
    ),
    model,
    modelDir: path.join(ROOT, "models", "inpainting", model),
    onProgress: qaProgress,
    runRootDir: path.join(options.outputDir, ".koharu-runtime", model),
    runtimeDir: path.join(ROOT, "runtime", "koharu-inpainting"),
  });
}

async function processEntry({ entry, engines, modules, options, runner }) {
  const chapterPath = path.join(
    path.dirname(path.dirname(entry.imagePath)),
    "chapter.json",
  );
  const chapter = JSON.parse(readFileSync(chapterPath, "utf8"));
  const page = chapter.pages.find((candidate) => candidate.id === entry.pageId);
  if (!page) throw new Error(`Page missing from chapter: ${entry.pageId}`);
  const extension = path.extname(entry.imagePath) || ".png";
  const stem = String(entry.index).padStart(3, "0");
  const sourcePath = path.join(
    options.outputDir,
    "source",
    `${stem}${extension}`,
  );
  copyFileSync(entry.imagePath, sourcePath);
  const qaPage = {
    ...page,
    imagePath: sourcePath,
    inpaintedImagePath: undefined,
  };
  const signal = new AbortController().signal;
  const startedAt = performance.now();
  const prepass = await modules.bubbleLayoutJob.runBubbleLayoutMaskPrepass({
    config: { policy: "balanced", overwriteManual: false },
    page: qaPage,
    runner,
    signal,
  });
  if (!prepass.typographySegmentation) {
    throw new Error("Koharu prepass did not return typography segmentation.");
  }
  const image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) throw new Error(`Unable to decode ${sourcePath}`);
  const size = image.getSize();
  const maskContext = modules.patternMask.buildPatternPageMask({
    bitmap: image.toBitmap(),
    bubbleLayoutConstraintBlockIds: prepass.bubbleLayoutConstraintBlockIds,
    height: size.height,
    mode: "flux-region",
    page: prepass.page,
    sharedInpaintGroupIdsByBlock: prepass.sharedInpaintGroupIdsByBlock,
    typographySegmentation: prepass.typographySegmentation,
    width: size.width,
  });
  const maskPath = path.join(options.outputDir, "masks", `${stem}.png`);
  writeFileSync(maskPath, renderMaskPreview(image, maskContext, modules));
  const outputs = [];
  for (const engine of engines) {
    const engineStartedAt = performance.now();
    const result = await modules.inpainting.inpaintPatternPage(prepass.page, {
      bubbleLayoutConstraintBlockIds: prepass.bubbleLayoutConstraintBlockIds,
      inpaintingEngine: engine,
      sharedInpaintGroupIdsByBlock: prepass.sharedInpaintGroupIdsByBlock,
      signal,
      typographySegmentation: prepass.typographySegmentation,
    });
    if (!result.page.inpaintedImagePath) {
      throw new Error(
        `${engine.model} produced no output for ${entry.pageName}`,
      );
    }
    outputs.push({
      backend: engine.backend,
      blocksErased: result.blocksErased,
      elapsedMs: performance.now() - engineStartedAt,
      model: engine.model,
      resultPath: result.page.inpaintedImagePath,
    });
  }
  return {
    cohortIndex: entry.index,
    pageId: entry.pageId,
    pageName: entry.pageName,
    sourcePath,
    maskPath,
    outputs,
    blocks: page.blocks.length,
    blocksErased: Math.min(...outputs.map((output) => output.blocksErased)),
    typographyDetections: prepass.typographySegmentation.detections.filter(
      (detection) =>
        detection.label === "text" || detection.label === "onomatopoeia",
    ).length,
    modelMaskPixels: countWindowMaskPixels(maskContext.inpaintWindowMasks),
    opaqueCorePixels: countWindowMaskPixels(maskContext.inpaintCompositeMasks),
    featherEnvelopePixels: countConstraintPixels(
      maskContext.inpaintWindowConstraints,
    ),
    featherPxByWindow: maskContext.inpaintCompositeFeatherPx,
    elapsedMs: performance.now() - startedAt,
  };
}

function renderMaskPreview(image, context, modules) {
  const size = image.getSize();
  const bitmap = Buffer.from(image.toBitmap());
  const model = unionWindowMasks(context.inpaintWindowMasks, size, modules);
  const core = unionWindowMasks(context.inpaintCompositeMasks, size, modules);
  const envelope = unionWindowMasks(
    context.inpaintWindowConstraints.filter(Boolean),
    size,
    modules,
  );
  for (let index = 0; index < size.width * size.height; index += 1) {
    if (model[index]) blendPixel(bitmap, index, [0, 190, 255], 0.1);
    if (envelope[index]) blendPixel(bitmap, index, [255, 176, 0], 0.35);
    if (core[index]) blendPixel(bitmap, index, [255, 30, 120], 0.72);
  }
  return nativeImage.createFromBitmap(bitmap, size).toPNG();
}

function unionWindowMasks(masks, size, modules) {
  const output = new Uint8Array(size.width * size.height);
  for (const mask of masks) {
    const expanded = modules.windowMask.expandWindowMaskToPage(
      mask,
      size.width,
      size.height,
    );
    for (let index = 0; index < output.length; index += 1) {
      if (expanded[index]) output[index] = 1;
    }
  }
  return output;
}

function blendPixel(bitmap, index, color, alpha) {
  const offset = index * 4;
  for (let channel = 0; channel < 3; channel += 1) {
    bitmap[offset + channel] = Math.round(
      (bitmap[offset + channel] || 0) * (1 - alpha) + color[channel] * alpha,
    );
  }
  bitmap[offset + 3] = 255;
}

async function writeGallery(outputDir, report) {
  const rows = report.results
    .map(
      (result) => `<section>
<h2>${escapeHtml(`${result.cohortIndex}. ${result.pageName}`)}</h2>
<p>pink = fully opaque deletion core · amber = outward feather envelope · cyan = broad model mask<br>
feather ${result.featherPxByWindow.join(", ")}px · ${Math.round(result.elapsedMs)}ms</p>
<div class="panels" style="grid-template-columns:repeat(${2 + result.outputs.length},minmax(0,1fr))">
<figure><figcaption>ORIGINAL</figcaption><img src="${pathToFileURL(result.sourcePath).href}"></figure>
<figure><figcaption>MASK: CORE + FEATHER + MODEL INPUT</figcaption><img src="${pathToFileURL(result.maskPath).href}"></figure>
${result.outputs
  .map(
    (output) =>
      `<figure><figcaption>${escapeHtml(output.model.toUpperCase())} RESULT · ${Math.round(output.elapsedMs)}ms</figcaption><img src="${pathToFileURL(output.resultPath).href}"></figure>`,
  )
  .join("\n")}
</div></section>`,
    )
    .join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>Koharu Flux feather QA</title>
<style>body{margin:0;padding:20px;background:#101217;color:#f5f1e8;font:14px Segoe UI,Malgun Gothic,sans-serif}section{margin:0 0 24px;padding:14px;background:#181c23;border:1px solid #303846;border-radius:10px}h2{margin:0 0 6px}p{color:#c7c0b5;line-height:1.5}.panels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}figure{margin:0}figcaption{margin:0 0 6px;font-weight:700;color:#f7c86f}img{display:block;width:100%;height:auto;background:#090b0e}</style>${rows}`;
  const htmlPath = path.join(outputDir, "gallery.html");
  writeFileSync(htmlPath, html);
  const panelCount = Math.max(
    ...report.results.map((result) => 2 + result.outputs.length),
  );
  const window = new BrowserWindow({
    show: false,
    width: Math.max(1800, panelCount * 600),
    height: Math.max(900, report.results.length * 900),
    webPreferences: { offscreen: true },
  });
  await window.loadFile(htmlPath);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const image = await window.webContents.capturePage();
  writeFileSync(path.join(outputDir, "contact-sheet.png"), image.toPNG());
  window.destroy();
}

function countWindowMaskPixels(masks) {
  return masks.reduce(
    (total, mask) =>
      total + mask.data.reduce((sum, value) => sum + (value ? 1 : 0), 0),
    0,
  );
}

function countConstraintPixels(masks) {
  return countWindowMaskPixels(masks.filter(Boolean));
}

function loadCompiledModules() {
  return {
    bubbleLayout: require(
      path.join(ROOT, "out", "main", "bubbleLayout", "bubbleLayoutFacade.js"),
    ),
    bubbleLayoutJob: require(
      path.join(ROOT, "out", "main", "jobs", "bubbleLayoutJob.js"),
    ),
    inpainting: require(path.join(ROOT, "out", "main", "inpainting.js")),
    gpuInfo: require(path.join(ROOT, "out", "main", "gpuInfo.js")),
    patternMask: require(
      path.join(ROOT, "out", "main", "inpainting", "patternPageMask.js"),
    ),
    windowMask: require(
      path.join(ROOT, "out", "main", "inpainting", "inpaintingWindowMask.js"),
    ),
  };
}

function stageKoharuModel(dataRoot, sourcePath) {
  if (!existsSync(sourcePath))
    throw new Error(`Missing Koharu ONNX: ${sourcePath}`);
  const targetDir = path.join(
    dataRoot,
    "models",
    "bubble-layout",
    "koharu-layout-rfdetr-seg-2xl-1152",
  );
  const targetPath = path.join(targetDir, "rfdetr-seg-2xlarge.onnx");
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(targetPath)) copyFileSync(sourcePath, targetPath);
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key || "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  const outputDir = values.get("output");
  if (!outputDir) throw new Error("--output is required");
  const indices = String(values.get("indices") || "1")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10));
  if (indices.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(
      "--indices must be a comma-separated list of positive integers",
    );
  }
  const engineAliases = {
    aot: "aot-inpainting",
    flux: "flux-klein",
    lama: "lama-manga",
  };
  const engines = String(values.get("engines") || "flux")
    .split(",")
    .map((value) => engineAliases[value.trim()]);
  if (engines.some((value) => !value)) {
    throw new Error("--engines accepts flux,lama,aot");
  }
  return {
    cohortPath: path.resolve(values.get("cohort") || DEFAULT_COHORT),
    dataRoot: path.resolve(
      values.get("data-root") ||
        path.join(ROOT, ".tmp", "koharu-flux-feather-qa-data"),
    ),
    engines,
    indices,
    onnxPath: path.resolve(values.get("onnx") || DEFAULT_ONNX),
    outputDir: path.resolve(outputDir),
  };
}

function assertAbsentDirectory(directory) {
  if (existsSync(directory))
    throw new Error(`Output already exists: ${directory}`);
  mkdirSync(directory, { recursive: false });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function launchElectron(executable) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [__filename, ...process.argv.slice(2)], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.signal) {
    throw new Error(`Koharu Flux QA terminated by ${result.signal}.`);
  }
  process.exitCode = result.status ?? 1;
}

if (typeof electron === "string") {
  launchElectron(electron);
} else {
  main().catch((error) => {
    console.error(error);
    app.quit();
    process.exitCode = 1;
  });
}
