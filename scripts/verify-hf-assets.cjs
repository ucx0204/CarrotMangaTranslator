// @ts-check
const { readFileSync } = require("node:fs");
const path = require("node:path");
const {
  PADDLE_OCR_MODEL_DOWNLOADS,
} = require("../src/main/runtime/simple-page-defaults.cjs");

const ROOT = path.resolve(__dirname, "..");
const MAX_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30000;

const modelPresets = readSource("src/shared/modelPresets.ts");
const fluxConstants = readSource("src/main/inpainting/fluxAssets/constants.ts");
const koharuAssets = readSource("src/main/inpainting/koharuAssets.ts");

const assets = [
  sourceAsset(
    "Gemma 12B model",
    modelPresets,
    "GEMMA_12B_MODEL_REPO",
    "GEMMA_12B_MODEL_FILE_Q4_K_M",
  ),
  sourceAsset(
    "Gemma 12B mmproj",
    modelPresets,
    "GEMMA_12B_MMPROJ_REPO",
    "GEMMA_12B_MMPROJ_FILE",
  ),
  sourceAsset(
    "Gemma 26B model",
    modelPresets,
    "GEMMA_26B_MODEL_REPO",
    "GEMMA_26B_MODEL_FILE_IQ3_S",
  ),
  sourceAsset(
    "Gemma 26B mmproj",
    modelPresets,
    "GEMMA_26B_MMPROJ_REPO",
    "GEMMA_26B_MMPROJ_FILE",
  ),
  sourceAsset(
    "Gemma 31B model",
    modelPresets,
    "GEMMA_31B_MODEL_REPO",
    "GEMMA_31B_MODEL_FILE_IQ3_S",
  ),
  sourceAsset(
    "Gemma 31B mmproj",
    modelPresets,
    "GEMMA_31B_MMPROJ_REPO",
    "GEMMA_31B_MMPROJ_FILE",
  ),
  sourceAsset(
    "Gemma draft model",
    modelPresets,
    "DEFAULT_GEMMA_DRAFT_MODEL_REPO",
    "DEFAULT_GEMMA_DRAFT_MODEL_FILE",
  ),
  sourceAsset(
    "Flux model",
    fluxConstants,
    "FLUX_MODEL_REPO",
    "FLUX_MODEL_FILE",
  ),
  sourceAsset("Flux VAE", fluxConstants, "FLUX_VAE_REPO", "FLUX_VAE_FILE"),
  sourceAsset(
    "Flux SDCPP VAE",
    fluxConstants,
    "FLUX_VAE_REPO",
    "FLUX_SDCPP_VAE_FILE",
  ),
  sourceAsset(
    "Flux SDCPP LLM",
    fluxConstants,
    "FLUX_SDCPP_LLM_REPO",
    "FLUX_SDCPP_LLM_FILE",
  ),
  sourceAsset("AOT config", koharuAssets, "AOT_MODEL_REPO", "AOT_CONFIG_FILE"),
  sourceAsset("AOT model", koharuAssets, "AOT_MODEL_REPO", "AOT_MODEL_FILE"),
  sourceAsset(
    "LaMa Manga model",
    koharuAssets,
    "LAMA_MODEL_REPO",
    "LAMA_MODEL_FILE",
  ),
  ...PADDLE_OCR_MODEL_DOWNLOADS.flatMap((entry) =>
    entry.files.map((file) => ({
      label: `${entry.name}: ${file}`,
      repo: entry.repo,
      file,
    })),
  ),
];

async function main() {
  const failures = [];
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENCY, assets.length) },
      async () => {
        while (nextIndex < assets.length) {
          const asset = assets[nextIndex];
          nextIndex += 1;
          try {
            const size = await verifyAsset(asset);
            process.stdout.write(`ok ${asset.label} (${formatBytes(size)})\n`);
          } catch (error) {
            failures.push({ asset, error });
            process.stderr.write(
              `failed ${asset.label}: ${formatError(error)}\n`,
            );
          }
        }
      },
    ),
  );
  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${assets.length} built-in Hugging Face assets failed verification.`,
    );
  }
  process.stdout.write(
    `Verified ${assets.length} built-in Hugging Face assets.\n`,
  );
}

/** @param {{ label: string; repo: string; file: string }} asset */
async function verifyAsset(asset) {
  const url = buildHfResolveUrl(asset.repo, asset.file);
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": "carrot-manga-translator-release-check",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText || ""}`.trim(),
        );
      }
      const size = Number(response.headers.get("content-length"));
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error("missing positive Content-Length");
      }
      return size;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw new Error(`${url}: ${formatError(lastError)}`);
}

/** @param {string} relativePath */
function readSource(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** @param {string} label @param {string} source @param {string} repoName @param {string} fileName */
function sourceAsset(label, source, repoName, fileName) {
  return {
    label,
    repo: readStringConstant(source, repoName),
    file: readStringConstant(source, fileName),
  };
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

/** @param {string} repo @param {string} file */
function buildHfResolveUrl(repo, file) {
  const encodedFile = file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repo}/resolve/main/${encodedFile}`;
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** @param {unknown} error */
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
