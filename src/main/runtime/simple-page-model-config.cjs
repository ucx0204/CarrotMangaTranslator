const path = require("node:path");

const {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_HF_FILE,
  DEFAULT_MMPROJ_FILE,
  DEFAULT_MMPROJ_HF,
  DEFAULT_MODEL_HF
} = require("./simple-page-defaults.cjs");

function resolveConfiguredModelSource(options = {}) {
  return String(options.modelSource ?? "").trim() === "local" ? "local" : "huggingface";
}

function resolveModelProvider(options = {}) {
  return String(options.modelProvider ?? "").trim() === "openai-codex" ? "openai-codex" : "gemma";
}

function isOpenAICodexProvider(options = {}) {
  return resolveModelProvider(options) === "openai-codex";
}

function resolveProviderDisplayName(options = {}) {
  return isOpenAICodexProvider(options) ? "OpenAI Codex" : "Gemma";
}

function resolveConfiguredCodexModel(options = {}) {
  return String(options.codexModel ?? process.env.MANGA_TRANSLATOR_CODEX_MODEL ?? "").trim() || DEFAULT_CODEX_MODEL;
}

function resolveConfiguredCodexReasoningEffort(options = {}) {
  const value = String(process.env.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT ?? options.codexReasoningEffort ?? "").trim();
  if (value === "minimal") {
    return "low";
  }
  return ["none", "low", "medium", "high", "xhigh"].includes(value) ? value : DEFAULT_CODEX_REASONING_EFFORT;
}

function resolveConfiguredLocalModelPath(options = {}) {
  const value = String(options.localModelPath ?? "").trim();
  return value ? path.resolve(value) : null;
}

function resolveConfiguredLocalMmprojPath(options = {}) {
  const value = String(options.localMmprojPath ?? "").trim();
  return value ? path.resolve(value) : null;
}

function resolveConfiguredModelRepo(options = {}) {
  return String(options.modelRepo ?? process.env.MANGA_TRANSLATOR_MODEL_HF ?? "").trim() || DEFAULT_MODEL_HF;
}

function resolveConfiguredModelFile(options = {}) {
  return String(options.modelFile ?? process.env.LLAMA_ARG_HF_FILE ?? "").trim() || DEFAULT_HF_FILE;
}

function resolveConfiguredMmprojRepo(options = {}) {
  return String(options.mmprojRepo ?? process.env.MANGA_TRANSLATOR_MMPROJ_HF ?? "").trim() || DEFAULT_MMPROJ_HF;
}

function resolveConfiguredMmprojFile(options = {}) {
  return String(options.mmprojFile ?? process.env.LLAMA_ARG_MMPROJ_FILE ?? "").trim() || DEFAULT_MMPROJ_FILE;
}

function resolveConfiguredDraftModelRepo(options = {}) {
  return String(options.draftModelRepo ?? process.env.MANGA_TRANSLATOR_DRAFT_MODEL_HF ?? "").trim();
}

function resolveConfiguredDraftModelFile(options = {}) {
  return String(options.draftModelFile ?? process.env.MANGA_TRANSLATOR_DRAFT_MODEL_FILE ?? "").trim();
}

function resolveConfiguredDraftModelUrl(options = {}) {
  const repo = resolveConfiguredDraftModelRepo(options);
  const file = resolveConfiguredDraftModelFile(options);
  if (!repo || !file) {
    return null;
  }
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

function shouldUseConfiguredMmproj(options = {}) {
  const explicitRepo = String(options.mmprojRepo ?? process.env.MANGA_TRANSLATOR_MMPROJ_HF ?? "").trim();
  const explicitFile = String(options.mmprojFile ?? process.env.LLAMA_ARG_MMPROJ_FILE ?? "").trim();
  if (explicitRepo || explicitFile) {
    return true;
  }
  return resolveConfiguredModelRepo(options) === DEFAULT_MODEL_HF;
}

module.exports = {
  isOpenAICodexProvider,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredDraftModelUrl,
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  resolveModelProvider,
  resolveProviderDisplayName,
  shouldUseConfiguredMmproj
};
