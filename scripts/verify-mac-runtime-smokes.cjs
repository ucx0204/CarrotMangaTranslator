#!/usr/bin/env node
// @ts-check

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const root = join(__dirname, "..");
const koharuSource = readFileSync(
  join(root, "src", "main", "inpainting", "koharuAssets.ts"),
  "utf8",
);
const OCR_SMOKE_FIXTURE = Object.freeze({
  fontPath: join(
    root,
    "src",
    "renderer",
    "src",
    "assets",
    "fonts",
    "ja",
    "dela-gothic-one.ttf",
  ),
  text: "日本語漫画",
  width: 640,
  height: 256,
});

const KOHARU_SMOKE_ASSETS = [
  {
    model: "aot-inpainting",
    repo: readStringConstant(koharuSource, "AOT_MODEL_REPO"),
    revision: readStringConstant(koharuSource, "AOT_MODEL_REVISION"),
    weightsFile: readStringConstant(koharuSource, "AOT_MODEL_FILE"),
    weightsSha256: readStringConstant(koharuSource, "AOT_MODEL_SHA256"),
    configFile: readStringConstant(koharuSource, "AOT_CONFIG_FILE"),
  },
  {
    model: "lama-manga",
    repo: readStringConstant(koharuSource, "LAMA_MODEL_REPO"),
    revision: readStringConstant(koharuSource, "LAMA_MODEL_REVISION"),
    weightsFile: readStringConstant(koharuSource, "LAMA_MODEL_FILE"),
    weightsSha256: readStringConstant(koharuSource, "LAMA_MODEL_SHA256"),
  },
];

/** @typedef {{ status: number | null; stdout: string; stderr: string; error?: Error }} CommandResult */

/** @param {string} command @param {string[]} args @param {{ env?: NodeJS.ProcessEnv; input?: string; timeout?: number }} [options] @returns {CommandResult} */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    timeout: options.timeout,
  });
  const normalized = {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    ...(result.error ? { error: result.error } : {}),
  };
  if (normalized.error || normalized.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${normalized.error?.message || normalized.stderr || normalized.stdout || `exit ${normalized.status}`}`,
    );
  }
  return normalized;
}

/** @param {string} source @param {string} name */
function readStringConstant(source, name) {
  const pattern = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRegExp(name)}\\s*=\\s*["']([^"']+)["']\\s*;`,
    "s",
  );
  const match = pattern.exec(source);
  if (!match) throw new Error(`String constant not found: ${name}`);
  return match[1];
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} filePath */
async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** @param {{ label: string; repo: string; revision: string; file: string; expectedSha256?: string }} asset @param {string} modelDir */
async function ensureHfAsset(asset, modelDir) {
  mkdirSync(modelDir, { recursive: true });
  const destination = join(modelDir, asset.file);
  const expected = String(asset.expectedSha256 || "").toLowerCase();
  if (existsSync(destination)) {
    if (!expected || (await sha256(destination)) === expected) {
      return destination;
    }
    rmSync(destination, { force: true });
  }
  const partPath = `${destination}.part`;
  rmSync(partPath, { force: true });
  const url = hfResolveUrl(asset.repo, asset.file, asset.revision);
  run(
    "curl",
    [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--retry-all-errors",
      "--output",
      partPath,
      url,
    ],
    { timeout: 60 * 60 * 1000 },
  );
  if (statSync(partPath).size <= 0) {
    throw new Error(`${asset.label} download was empty: ${url}`);
  }
  if (expected) {
    const actual = await sha256(partPath);
    if (actual !== expected) {
      rmSync(partPath, { force: true });
      throw new Error(
        `${asset.label} SHA-256 mismatch: expected ${expected}, got ${actual}`,
      );
    }
  }
  renameSync(partPath, destination);
  return destination;
}

/** @param {string} repo @param {string} file @param {string} revision */
function hfResolveUrl(repo, file, revision) {
  const encodedFile = file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${encodedFile}`;
}

/** @param {string} python @param {string} workRoot */
function createSmokeImages(python, workRoot) {
  mkdirSync(workRoot, { recursive: true });
  if (!existsSync(OCR_SMOKE_FIXTURE.fontPath)) {
    throw new Error(
      `Mac OCR smoke font is missing: ${OCR_SMOKE_FIXTURE.fontPath}`,
    );
  }
  const paths = {
    ocr: join(workRoot, "ocr-smoke.png"),
    input: join(workRoot, "inpaint-input.png"),
    mask: join(workRoot, "inpaint-mask.png"),
    bubble: join(workRoot, "inpaint-bubble.png"),
  };
  const script = [
    "from PIL import Image, ImageDraw, ImageFont",
    "import sys",
    `ocr = Image.new('RGB', (${OCR_SMOKE_FIXTURE.width}, ${OCR_SMOKE_FIXTURE.height}), 'white')`,
    "draw = ImageDraw.Draw(ocr)",
    "font_path = sys.argv[5]",
    "font = ImageFont.truetype(font_path, 72)",
    "draw.text((36, 72), sys.argv[6], fill='black', font=font)",
    "ocr.save(sys.argv[1])",
    "source = Image.new('RGB', (128, 128), (242, 242, 242))",
    "source_draw = ImageDraw.Draw(source)",
    "source_draw.rectangle((48, 48, 80, 80), fill='black')",
    "source.save(sys.argv[2])",
    "mask = Image.new('L', (128, 128), 0)",
    "ImageDraw.Draw(mask).rectangle((48, 48, 80, 80), fill=255)",
    "mask.save(sys.argv[3])",
    "Image.new('L', (128, 128), 0).save(sys.argv[4])",
  ].join("\n");
  run(
    python,
    [
      "-c",
      script,
      paths.ocr,
      paths.input,
      paths.mask,
      paths.bubble,
      OCR_SMOKE_FIXTURE.fontPath,
      OCR_SMOKE_FIXTURE.text,
    ],
    {
      timeout: 60_000,
      env: buildSmokePythonEnv(workRoot),
    },
  );
  return paths;
}

/** @param {string} appPath @param {string} toolsDir @param {string} python @param {string} workRoot @param {ReturnType<typeof createSmokeImages>} images */
async function verifyOcrImageSmoke(
  appPath,
  toolsDir,
  python,
  workRoot,
  images,
) {
  const runtimePath = join(
    appPath,
    "Contents",
    "Resources",
    "app-runtime",
    "simple-page-translate.cjs",
  );
  const runtime = require(runtimePath);
  if (typeof runtime.collectOcrBboxHints !== "function") {
    throw new Error(`Packaged OCR runtime export is missing: ${runtimePath}`);
  }
  const result = await runtime.collectOcrBboxHints(
    createOcrSmokeRequest(images.ocr, toolsDir, workRoot),
  );
  const hints = Array.isArray(result?.hints) ? result.hints : [];
  if (hints.length === 0) {
    throw new Error(
      `Packaged Paddle OCR CPU image smoke returned no text: ${JSON.stringify(result)}`,
    );
  }
  run(
    python,
    [
      "-c",
      `from PIL import Image; import sys; assert Image.open(sys.argv[1]).size == (${OCR_SMOKE_FIXTURE.width}, ${OCR_SMOKE_FIXTURE.height})`,
      images.ocr,
    ],
    {
      timeout: 30_000,
      env: buildSmokePythonEnv(workRoot),
    },
  );
  console.log(`[mac-smoke] Paddle OCR CPU detected ${hints.length} region(s)`);
}

/**
 * @param {string} imagePath
 * @param {string} toolsDir
 * @param {string} workRoot
 */
function createOcrSmokeRequest(imagePath, toolsDir, workRoot) {
  return {
    imagePath,
    toolsDir,
    workingDir: workRoot,
    ocrRuntimeDir: join(workRoot, "ocr-runtime"),
    ocrDevice: "cpu",
    ocrBboxProvider: "paddleocr",
    ocrBboxMode: "ocr",
    ocrEngine: "paddle_static",
    ocrVersion: "PP-OCRv6",
    ocrTextDetectionModelName: "PP-OCRv6_small_det",
    ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
    ocrMergeMode: "semantic",
    sourceLanguage: "ja",
  };
}

/** @param {string} runner @param {string} python @param {string} workRoot @param {ReturnType<typeof createSmokeImages>} images */
async function verifyKoharuImageSmokes(runner, python, workRoot, images) {
  for (const asset of KOHARU_SMOKE_ASSETS) {
    const modelDir = join(workRoot, "models", asset.model);
    const weights = await ensureHfAsset(
      {
        label: `${asset.model} weights`,
        repo: asset.repo,
        revision: asset.revision,
        file: asset.weightsFile,
        expectedSha256: asset.weightsSha256,
      },
      modelDir,
    );
    const config = asset.configFile
      ? await ensureHfAsset(
          {
            label: `${asset.model} config`,
            repo: asset.repo,
            revision: asset.revision,
            file: asset.configFile,
          },
          modelDir,
        )
      : null;
    const output = join(workRoot, `${asset.model}-output.png`);
    const args = [
      "--model",
      asset.model,
      "--weights",
      weights,
      "--backend",
      "metal-native",
    ];
    if (config) args.push("--config", config);
    const request = createKoharuSmokeRequest(asset.model, images, output);
    const result = run(runner, args, {
      input: `${JSON.stringify(request)}\n${JSON.stringify({ type: "shutdown" })}\n`,
      timeout: 30 * 60 * 1000,
      env: {
        KOHARU_DATA_ROOT: join(workRoot, "koharu-data", asset.model),
        RUST_LOG: "warn",
      },
    });
    const response = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseOptionalJson)
      .find((value) => value?.id === asset.model);
    if (!response || response.ok !== true || !existsSync(output)) {
      throw new Error(
        `${asset.model} Metal 128x128 smoke failed: ${result.stdout}\n${result.stderr}`,
      );
    }
    run(
      python,
      [
        "-c",
        "from PIL import Image; import sys; image=Image.open(sys.argv[1]); image.load(); assert image.size == (128, 128)",
        output,
      ],
      { timeout: 30_000, env: buildSmokePythonEnv(workRoot) },
    );
    console.log(`[mac-smoke] ${asset.model} Metal 128x128 inpainting passed`);
  }
}

/**
 * @param {string} model
 * @param {{ input: string; mask: string; bubble: string }} images
 * @param {string} output
 */
function createKoharuSmokeRequest(model, images, output) {
  return {
    type: "inpaint",
    id: model,
    input: images.input,
    mask: images.mask,
    bubble_mask: images.bubble,
    output,
    windows: [[32, 32, 96, 96]],
    max_pixels: 128 * 128,
  };
}

/** @param {string} text @returns {Record<string, unknown> | null} */
function parseOptionalJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch (_error) {
    return null;
  }
}

/** @param {string} workRoot @returns {NodeJS.ProcessEnv} */
function buildSmokePythonEnv(workRoot) {
  return {
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: join(workRoot, "pycache"),
    PADDLE_PDX_CACHE_HOME: join(workRoot, "paddlex-cache"),
  };
}

/** @param {{ appPath: string }} options */
async function verifyMacRuntimeSmokes(options) {
  const toolsDir = join(options.appPath, "Contents", "Resources", "tools");
  const python = join(toolsDir, "python", "bin", "python3");
  const runner = join(
    toolsDir,
    "mgt-koharu-inpaint-runner",
    "mgt-koharu-inpaint-runner",
  );
  const workRoot = join(tmpdir(), "mgt-mac-runtime-smokes");
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  try {
    const images = createSmokeImages(python, workRoot);
    await verifyOcrImageSmoke(
      options.appPath,
      toolsDir,
      python,
      workRoot,
      images,
    );
    await verifyKoharuImageSmokes(runner, python, workRoot, images);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

module.exports = {
  KOHARU_SMOKE_ASSETS,
  OCR_SMOKE_FIXTURE,
  buildSmokePythonEnv,
  createKoharuSmokeRequest,
  createOcrSmokeRequest,
  verifyMacRuntimeSmokes,
};
