const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const {
  buildSystemPrompt,
  getOverlayPrompt
} = require("./simple-page-prompts.cjs");
const {
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  resolveModelProvider
} = require("./simple-page-model-config.cjs");
const {
  resolveHfHomeDir,
  resolveHubCacheDir
} = require("./simple-page-cache-paths.cjs");
const {
  resolveConfiguredMmprojUrl
} = require("./simple-page-model-assets.cjs");

async function saveArtifacts(options, result) {
  await mkdir(options.outputDir, { recursive: true });
  const systemPrompt = buildSystemPrompt(options);
  const imageVariants = result.requestBody?.imageVariants || [];
  const prompt = result.requestBody?.promptText || options.promptOverrideText || getOverlayPrompt(options, imageVariants);
  const payload = {
    label: options.label,
    imagePath: options.imagePath,
    createdAt: new Date().toISOString(),
    settings: {
      port: options.port,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      maxTokens: options.maxTokens,
      ctx: options.ctx,
      batch: options.batch,
      ubatch: options.ubatch,
      gemmaVramMode: options.gemmaVramMode,
      cacheTypeK: options.cacheTypeK,
      cacheTypeV: options.cacheTypeV,
      ctxCheckpoints: options.ctxCheckpoints,
      kvOffload: options.kvOffload,
      mmprojOffload: options.mmprojOffload,
      threads: options.threads,
      threadsBatch: options.threadsBatch,
      poll: options.poll,
      pollBatch: options.pollBatch,
      prioBatch: options.prioBatch,
      cacheIdleSlots: options.cacheIdleSlots,
      cacheReuse: options.cacheReuse,
      enableMetrics: options.enableMetrics,
      enablePerf: options.enablePerf,
      modelProvider: resolveModelProvider(options),
      modelSource: resolveConfiguredModelSource(options),
      modelRepo: resolveConfiguredModelRepo(options),
      modelFile: resolveConfiguredModelFile(options),
      mmprojRepo: resolveConfiguredMmprojRepo(options),
      mmprojFile: resolveConfiguredMmprojFile(options),
      mmprojUrl: resolveConfiguredMmprojUrl(options),
      localModelPath: resolveConfiguredLocalModelPath(options),
      localMmprojPath: resolveConfiguredLocalMmprojPath(options),
      codexModel: resolveConfiguredCodexModel(options),
      codexReasoningEffort: resolveConfiguredCodexReasoningEffort(options),
      codexOauthPort: options.codexOauthPort,
      fitTargetMb: options.fitTargetMb,
      imageMinTokens: options.imageMinTokens,
      imageMaxTokens: options.imageMaxTokens,
      includeEnhancedVariant: options.includeEnhancedVariant,
      enhancedMaxLongSide: options.enhancedMaxLongSide,
      enhancedContrast: options.enhancedContrast,
      hfHomeDir: resolveHfHomeDir(options),
      hfHubCacheDir: resolveHubCacheDir(options)
    },
    requestSummary: result.requestBody,
    systemPrompt,
    prompt,
    outputText: result.outputText,
    rawResponse: result.rawResponse
  };

  await writeFile(path.join(options.outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(path.join(options.outputDir, "result.md"), `${result.outputText.trim()}\n`, "utf8");
}

module.exports = {
  saveArtifacts
};
