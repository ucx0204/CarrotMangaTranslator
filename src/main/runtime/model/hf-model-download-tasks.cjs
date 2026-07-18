// @ts-check
const { resolveManagedHfFilePath } = require("../simple-page-cache-paths.cjs");
const {
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
} = require("../simple-page-model-config.cjs");
const { inspectModelLaunch } = require("./model-launch-target.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { useDraft?: boolean | null }} ModelAssetOptions */
/** @typedef {{ kind: string; label: string; repo?: string; file: string; url: string; destination: string; expectedSha256?: string; revision?: string; progressPhase?: string; progressTitle?: string; completeTitle?: string }} DownloadTask */
/** @typedef {ReturnType<typeof inspectModelLaunch>} ModelLaunchTarget */

const PINNED_BUILT_IN_GEMMA_ASSETS = new Map(
  [
    [
      "culturerevolt/gemma-4-12b-heretic-abliterated-GGUF",
      "gemma-4-12b-heretic-Q4_K_M.gguf",
      "ca1e60be3a69f79a699ff85c9c3f97a1614e5617",
      "6c4067ea0210d2367b2dbdd460d2dd86032a9b6e8dcbe03b83a3ea0a0a16dbee",
    ],
    [
      "ggml-org/gemma-4-12B-it-GGUF",
      "mmproj-gemma-4-12B-it-BF16.gguf",
      "d72ee27227da2ba16c725180ddd507ee96208d23",
      "9b1edfa05b634728ca4bfd60b4e6b278e95166c078fa54ae4fa83e680112fd1d",
    ],
    [
      "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-i1-GGUF",
      "gemma-4-26B-A4B-it-ultra-uncensored-heretic.i1-IQ3_S.gguf",
      "9cada68ea11a8f361e4b16a7a97e53d99b0918c0",
      "b7c13509c19383cf8fa4c8b1731ff5bd3a6e2f0e0ca5a63958afee1ee64f387d",
    ],
    [
      "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF",
      "gemma-4-26B-A4B-it-ultra-uncensored-heretic.mmproj-Q8_0.gguf",
      "8842483d589b4add67223d1d8c3fff81a3d5260e",
      "b9dd7e71eb78b44c4c9d3a0aa6173a1e022c2c4f58aa0fd03807be3f8cba4353",
    ],
    [
      "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF",
      "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf",
      "333ecaddf4ffed8b01b3c484c38f869d2ccbf575",
      "60f21ababa92c6ffd9808f7b786b541d6f8963ccc32c5f5978a40930dbb7bdc2",
    ],
    [
      "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF",
      "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf",
      "bebefd2123b11ba23561bd5308aa7756f96560c4",
      "1816ba44b0011268b23dd9a48c975a417a83bff1179709c57d891b42bd3607cc",
    ],
    [
      "Anbeeld/gemma-4-31B-it-DFlash-GGUF",
      "gemma4-31b-it-dflash-IQ4_XS.gguf",
      "66a750fccd64d8235e1cc249490cc9ce06335b0f",
      "3ec6a5cb58d5ec1ee14cb3ce8dc297998a0d69eca9f6377851dcea4365c0d2d4",
    ],
  ].map(([repo, file, revision, expectedSha256]) => [
    assetKey(repo, file),
    Object.freeze({ revision, expectedSha256 }),
  ]),
);

/** @param {ModelAssetOptions} [options] @param {ModelLaunchTarget} [target] @returns {DownloadTask[]} */
function collectRequiredHfDownloads(
  options = {},
  target = inspectModelLaunch(options),
) {
  if (["openai-codex", "openai-api"].includes(target.launchMode)) return [];
  return [
    buildModelDownload(options, target),
    buildMmprojDownload(options, target),
    buildDraftDownload(options, target),
  ].filter(isDownloadTask);
}

/** @param {unknown} value @returns {value is DownloadTask} */
function isDownloadTask(value) {
  return Boolean(value);
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target @returns {DownloadTask | null} */
function buildModelDownload(options, target) {
  if (target.launchMode === "local" || target.modelPath) return null;
  const repo = resolveConfiguredModelRepo(options);
  const file = resolveConfiguredModelFile(options);
  return buildTask(
    "model",
    "Gemma 모델",
    repo,
    file,
    hfUrl(repo, file),
    options,
  );
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target @returns {DownloadTask | null} */
function buildMmprojDownload(options, target) {
  if (!target.mmprojUrl || target.mmprojPath) return null;
  return buildTask(
    "mmproj",
    "Gemma vision mmproj",
    resolveConfiguredMmprojRepo(options),
    resolveConfiguredMmprojFile(options),
    target.mmprojUrl,
    options,
  );
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target @returns {DownloadTask | null} */
function buildDraftDownload(options, target) {
  if (!options.useDraft || !target.draftModelUrl || target.draftModelPath)
    return null;
  return buildTask(
    "draft",
    "Gemma draft 모델",
    resolveConfiguredDraftModelRepo(options),
    resolveConfiguredDraftModelFile(options),
    target.draftModelUrl,
    options,
  );
}

/** @param {string} kind @param {string} label @param {string} repo @param {string} file @param {string} url @param {ModelAssetOptions} options @returns {DownloadTask | null} */
function buildTask(kind, label, repo, file, url, options) {
  const destination = resolveManagedHfFilePath(options, repo, file);
  const pin = resolvePinnedGemmaAsset(repo, file);
  return repo && file && destination
    ? {
        kind,
        label,
        repo,
        file,
        url: pin ? hfUrl(repo, file, pin.revision) : url,
        destination,
        ...(pin || {}),
      }
    : null;
}

/** @param {string} repo @param {string} file @param {string} [revision] */
function hfUrl(repo, file, revision = "main") {
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${encodeURIComponent(file)}`;
}

/** @param {string} repo @param {string} file */
function assetKey(repo, file) {
  return `${repo}\n${file}`;
}

/** @param {string} repo @param {string} file */
function resolvePinnedGemmaAsset(repo, file) {
  return PINNED_BUILT_IN_GEMMA_ASSETS.get(assetKey(repo, file)) || null;
}

module.exports = { collectRequiredHfDownloads, resolvePinnedGemmaAsset };
