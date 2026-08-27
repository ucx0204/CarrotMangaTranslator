// @ts-check
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const {
  PADDLE_OCR_MODEL_DOWNLOADS,
} = require("../src/main/runtime/simple-page-defaults.cjs");
const {
  resolvePinnedGemmaAsset,
} = require("../src/main/runtime/model/hf-model-download-tasks.cjs");

const ROOT = path.resolve(__dirname, "..");
const MAX_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30000;

const modelPresets = readSource("src/shared/modelPresets.ts");
const fluxConstants = readSource("src/main/inpainting/fluxAssets/constants.ts");
const koharuAssets = readSource("src/main/inpainting/koharuAssets.ts");
const animeTextAssets = readSource("src/main/textDetection/animeTextAssets.ts");
const bubbleLayoutAssets = readSource("src/main/bubbleLayout/constants.ts");
const animeTextContract = JSON.parse(
  readSource("src/main/runtime/ocr/anime-text-evidence-contract.json"),
);

const assets = [
  pinnedGemmaAsset(
    "Gemma 12B model",
    modelPresets,
    "GEMMA_12B_MODEL_REPO",
    "GEMMA_12B_MODEL_FILE_Q4_K_M",
  ),
  pinnedGemmaAsset(
    "Gemma 12B mmproj",
    modelPresets,
    "GEMMA_12B_MMPROJ_REPO",
    "GEMMA_12B_MMPROJ_FILE",
  ),
  pinnedGemmaAsset(
    "Gemma 12B QAT model",
    modelPresets,
    "GEMMA_12B_QAT_MODEL_REPO",
    "GEMMA_12B_QAT_MODEL_FILE_Q4_K_M",
  ),
  pinnedGemmaAsset(
    "Gemma 12B QAT mmproj",
    modelPresets,
    "GEMMA_12B_QAT_MMPROJ_REPO",
    "GEMMA_12B_QAT_MMPROJ_FILE",
  ),
  pinnedGemmaAsset(
    "Gemma 12B QAT MTP model",
    modelPresets,
    "GEMMA_12B_QAT_MTP_MODEL_REPO",
    "GEMMA_12B_QAT_MTP_MODEL_FILE",
  ),
  pinnedGemmaAsset(
    "Gemma 26B model",
    modelPresets,
    "GEMMA_26B_MODEL_REPO",
    "GEMMA_26B_MODEL_FILE_IQ3_S",
  ),
  pinnedGemmaAsset(
    "Gemma 26B mmproj",
    modelPresets,
    "GEMMA_26B_MMPROJ_REPO",
    "GEMMA_26B_MMPROJ_FILE",
  ),
  pinnedGemmaAsset(
    "Gemma 26B QAT model",
    modelPresets,
    "GEMMA_26B_QAT_MODEL_REPO",
    "GEMMA_26B_QAT_MODEL_FILE_Q4_K_M",
  ),
  pinnedGemmaAsset(
    "Gemma 26B QAT mmproj",
    modelPresets,
    "GEMMA_26B_QAT_MMPROJ_REPO",
    "GEMMA_26B_QAT_MMPROJ_FILE",
  ),
  pinnedGemmaAsset(
    "Gemma 26B QAT MTP model",
    modelPresets,
    "GEMMA_26B_QAT_MTP_MODEL_REPO",
    "GEMMA_26B_QAT_MTP_MODEL_FILE",
  ),
  pinnedGemmaAsset(
    "Gemma 31B model",
    modelPresets,
    "GEMMA_31B_MODEL_REPO",
    "GEMMA_31B_MODEL_FILE_IQ3_S",
  ),
  pinnedGemmaAsset(
    "Gemma 31B mmproj",
    modelPresets,
    "GEMMA_31B_MMPROJ_REPO",
    "GEMMA_31B_MMPROJ_FILE",
  ),
  pinnedGemmaAsset(
    "Gemma 31B QAT model",
    modelPresets,
    "GEMMA_31B_QAT_MODEL_REPO",
    "GEMMA_31B_QAT_MODEL_FILE_Q4_K_M",
  ),
  pinnedGemmaAsset(
    "Gemma 31B QAT mmproj",
    modelPresets,
    "GEMMA_31B_QAT_MMPROJ_REPO",
    "GEMMA_31B_QAT_MMPROJ_FILE",
  ),
  pinnedGemmaAsset(
    "Gemma 31B QAT MTP model",
    modelPresets,
    "GEMMA_31B_QAT_MTP_MODEL_REPO",
    "GEMMA_31B_QAT_MTP_MODEL_FILE",
  ),
  pinnedGemmaAsset(
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
    "FLUX_MODEL_REVISION",
  ),
  sourceAsset(
    "Flux VAE",
    fluxConstants,
    "FLUX_VAE_REPO",
    "FLUX_VAE_FILE",
    "FLUX_VAE_REVISION",
  ),
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
  sourceAsset(
    "AOT config",
    koharuAssets,
    "AOT_MODEL_REPO",
    "AOT_CONFIG_FILE",
    "AOT_MODEL_REVISION",
  ),
  sourceAsset(
    "AOT model",
    koharuAssets,
    "AOT_MODEL_REPO",
    "AOT_MODEL_FILE",
    "AOT_MODEL_REVISION",
  ),
  sourceAsset(
    "LaMa Manga model",
    koharuAssets,
    "LAMA_MODEL_REPO",
    "LAMA_MODEL_FILE",
    "LAMA_MODEL_REVISION",
  ),
  {
    label: "Anime text YOLO model",
    repo: readStringConstant(animeTextAssets, "ANIME_TEXT_MODEL_REPO"),
    file: readStringConstant(animeTextAssets, "ANIME_TEXT_MODEL_FILE"),
    revision: String(animeTextContract.modelRevision),
    expectedSha256: readStringConstant(
      animeTextAssets,
      "ANIME_TEXT_MODEL_SHA256",
    ),
  },
  {
    label: "KoharuLayout bubble and text segmentation ONNX",
    repo: readStringConstant(bubbleLayoutAssets, "KOHARU_LAYOUT_ONNX_REPO"),
    file: readStringConstant(bubbleLayoutAssets, "KOHARU_LAYOUT_ONNX_FILE"),
    revision: readStringConstant(
      bubbleLayoutAssets,
      "KOHARU_LAYOUT_ONNX_REVISION",
    ),
    expectedSha256: readStringConstant(
      bubbleLayoutAssets,
      "KOHARU_LAYOUT_ONNX_SHA256",
    ),
  },
  {
    label: "ONNX font-inference WASM runtime",
    url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${readStringConstant(
      bubbleLayoutAssets,
      "ONNXRUNTIME_WEB_VERSION",
    )}/dist/${readStringConstant(
      bubbleLayoutAssets,
      "ONNXRUNTIME_WEB_WASM_BINARY_FILE",
    )}`,
    expectedSha256: readStringConstant(
      bubbleLayoutAssets,
      "ONNXRUNTIME_WEB_WASM_BINARY_SHA256",
    ),
    expectedBytes: readNumberConstant(
      bubbleLayoutAssets,
      "ONNXRUNTIME_WEB_WASM_BINARY_BYTES",
    ),
  },
  ...PADDLE_OCR_MODEL_DOWNLOADS.flatMap((entry) =>
    entry.files.map((file) => ({
      label: `${entry.name}: ${file}`,
      repo: entry.repo,
      file,
      revision: entry.revision,
      ...(file === entry.weightsFile
        ? { expectedSha256: entry.weightsSha256 }
        : {}),
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

/**
 * @typedef {{
 *   label:string;
 *   repo?:string;
 *   file?:string;
 *   url?:string;
 *   revision?:string;
 *   expectedSha256?:string;
 *   expectedBytes?:number;
 * }} RemoteAsset
 */

/** @param {RemoteAsset} asset */
async function verifyAsset(asset) {
  const url =
    asset.url ||
    buildHfResolveUrl(
      requireAssetField(asset.repo, asset.label, "repo"),
      requireAssetField(asset.file, asset.label, "file"),
      asset.revision,
    );
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return asset.url
        ? await verifyDirectAsset(url, asset)
        : await verifyAssetHead(url, asset);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw new Error(`${url}: ${formatError(lastError)}`);
}

/** @param {string} url @param {RemoteAsset} asset */
async function verifyDirectAsset(url, asset) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "Accept-Encoding": "identity",
      "User-Agent": "carrot-manga-translator-release-check",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assertHeadStatus(response);
  if (!response.body) {
    throw new Error("download response is missing a body");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  if (asset.expectedBytes && bytes !== asset.expectedBytes) {
    throw new Error(
      `size mismatch: expected ${asset.expectedBytes}, got ${bytes}`,
    );
  }
  const actualSha256 = hash.digest("hex");
  if (
    asset.expectedSha256 &&
    actualSha256 !== asset.expectedSha256.toLowerCase()
  ) {
    throw new Error(
      `SHA-256 mismatch: expected ${asset.expectedSha256}, got ${actualSha256}`,
    );
  }
  return bytes;
}

/** @param {string} url @param {RemoteAsset} asset */
async function verifyAssetHead(url, asset) {
  const metadata = await fetchHead(url, "manual");
  assertHeadStatus(metadata);
  verifyPinnedSha256(asset, metadata);
  const linkedSize = readPositiveHeader(metadata, "x-linked-size");
  if (!isRedirect(metadata)) {
    return linkedSize || requireContentLength(metadata);
  }
  const location = metadata.headers.get("location");
  if (!location) {
    throw new Error("redirect response is missing Location");
  }
  const content = await fetchHead(
    new URL(location, metadata.url).href,
    "follow",
  );
  assertHeadStatus(content);
  return linkedSize || requireContentLength(content);
}

/** @param {string} url @param {"manual"|"follow"} redirect */
function fetchHead(url, redirect) {
  return fetch(url, {
    method: "HEAD",
    redirect,
    headers: {
      "Accept-Encoding": "identity",
      "User-Agent": "carrot-manga-translator-release-check",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** @param {Response} response */
function assertHeadStatus(response) {
  if (response.ok || isRedirect(response)) return;
  throw new Error(
    `HTTP ${response.status} ${response.statusText || ""}`.trim(),
  );
}

/** @param {Response} response */
function isRedirect(response) {
  return response.status >= 300 && response.status < 400;
}

/** @param {RemoteAsset} asset @param {Response} response */
function verifyPinnedSha256(asset, response) {
  if (!asset.expectedSha256) return;
  const actual = normalizeEtag(
    response.headers.get("x-linked-etag") || response.headers.get("etag"),
  );
  if (!/^[a-f0-9]{64}$/.test(actual)) {
    throw new Error("missing Hugging Face SHA-256 object metadata");
  }
  if (actual !== asset.expectedSha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch: expected ${asset.expectedSha256}, got ${actual}`,
    );
  }
}

/** @param {string|null} value */
function normalizeEtag(value) {
  return String(value ?? "")
    .trim()
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "")
    .toLowerCase();
}

/** @param {Response} response @param {string} name */
function readPositiveHeader(response, name) {
  const value = Number(response.headers.get(name));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** @param {Response} response */
function requireContentLength(response) {
  const size = readPositiveHeader(response, "content-length");
  if (size <= 0) {
    throw new Error("missing positive Content-Length");
  }
  return size;
}

/** @param {string} relativePath */
function readSource(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * @param {string} label
 * @param {string} source
 * @param {string} repoName
 * @param {string} fileName
 * @param {string=} revisionName
 * @param {string=} sha256Name
 */
function sourceAsset(
  label,
  source,
  repoName,
  fileName,
  revisionName,
  sha256Name,
) {
  return {
    label,
    repo: readStringConstant(source, repoName),
    file: readStringConstant(source, fileName),
    ...(revisionName
      ? { revision: readStringConstant(source, revisionName) }
      : {}),
    ...(sha256Name
      ? { expectedSha256: readStringConstant(source, sha256Name) }
      : {}),
  };
}

/** @param {string} label @param {string} source @param {string} repoName @param {string} fileName */
function pinnedGemmaAsset(label, source, repoName, fileName) {
  const asset = sourceAsset(label, source, repoName, fileName);
  const pin = resolvePinnedGemmaAsset(asset.repo, asset.file);
  if (!pin) {
    throw new Error(
      `Built-in Gemma asset is not pinned: ${asset.repo}/${asset.file}`,
    );
  }
  return { ...asset, ...pin };
}

/** @param {string} source @param {string} name @param {Set<string>} [visited] */
function readStringConstant(source, name, visited = new Set()) {
  const literalPattern = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRegExp(name)}\\s*=\\s*["']([^"']+)["']\\s*;`,
    "s",
  );
  const literalMatch = literalPattern.exec(source);
  if (literalMatch) return literalMatch[1];

  const aliasPattern = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRegExp(name)}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;`,
    "s",
  );
  const aliasMatch = aliasPattern.exec(source);
  if (!aliasMatch) throw new Error(`String constant not found: ${name}`);
  if (visited.has(name)) {
    throw new Error(`String constant alias cycle found: ${name}`);
  }
  visited.add(name);
  return readStringConstant(source, aliasMatch[1], visited);
}

/** @param {string} source @param {string} name */
function readNumberConstant(source, name) {
  const pattern = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRegExp(name)}\\s*=\\s*([\\d_]+)\\s*;`,
    "s",
  );
  const match = pattern.exec(source);
  if (!match) throw new Error(`Number constant not found: ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

/** @param {string|undefined} value @param {string} label @param {string} name */
function requireAssetField(value, label, name) {
  if (!value) throw new Error(`${label} is missing ${name}`);
  return value;
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} repo @param {string} file @param {string=} revision */
function buildHfResolveUrl(repo, file, revision = "main") {
  const encodedFile = file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${encodedFile}`;
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
