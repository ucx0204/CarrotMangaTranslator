import type {
  AppSettings,
  BlockFormatDefaults,
  GemmaVramMode,
} from "../../shared/types";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../../shared/blockFormat";
import {
  asRecord,
  inferHardwareVendorFromDefaults,
  resolveAnalysisScopeDefault,
  resolveBoolean,
  resolveCodexReasoningEffort,
  resolveContextTokens,
  resolveGemmaVramMode,
  resolveHexColor,
  resolveMaxTokens,
  resolveModelProvider,
  resolveModelSource,
  resolveNullableIntegerRange,
  resolveNullableNumberRange,
  resolveNullableReasoningEffort,
  resolveNonEmptyString,
  resolveNumberRange,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOpenAiCompatibleBaseUrl,
  resolveOptionalJsonObjectString,
  resolveOptionalString,
  resolvePortNumber,
} from "./appSettingsResolvers";
import { resolveDefaultAppSettings } from "./appSettingsDefaults";
import {
  resolveStoredFluxBackend,
  resolveStoredGemmaMmproj,
  resolveStoredGemmaModel,
  resolveStoredInpaintingModel,
  resolveStoredKoharuInpaintingBackend,
  resolveStoredLlamaRocmTarget,
  resolveStoredLlamaRuntimeProfile,
  resolveStoredOcrGpuCudaTag,
} from "./appSettingsStoredResolvers";
import { getModeAwareGemmaDefaults } from "./gemmaModelPresets";

export function normalizeAppSettings(
  raw: unknown,
  defaults = resolveDefaultAppSettings(),
): AppSettings {
  const record = asRecord(raw) ?? {};
  return {
    modelProvider: resolveModelProvider(
      record.modelProvider,
      defaults.modelProvider,
    ),
    gemma: normalizeGemmaSettings(asRecord(record.gemma), defaults),
    codex: normalizeCodexSettings(asRecord(record.codex), defaults),
    api: normalizeApiSettings(asRecord(record.api), defaults),
    ocr: normalizeOcrSettings(asRecord(record.ocr), defaults),
    ui: normalizeUiSettings(asRecord(record.ui), defaults),
    inpainting: normalizeInpaintingSettings(
      asRecord(record.inpainting),
      defaults,
    ),
    blockFormatDefaults: normalizeBlockFormatDefaults(
      asRecord(record.blockFormatDefaults),
      defaults,
    ),
    keybindings: normalizeKeybindings(record.keybindings, defaults),
    maxTokens: resolveMaxTokens(record.maxTokens, defaults.maxTokens),
    ctx: resolveContextTokens(record.ctx, defaults.ctx),
  };
}

function normalizeKeybindings(
  keybindings: unknown,
  defaults: AppSettings,
): NonNullable<AppSettings["keybindings"]> {
  const record = asRecord(keybindings);
  if (!record) {
    return { ...(defaults.keybindings ?? {}) };
  }
  const normalized: Record<string, string> = {};
  for (const [actionId, combo] of Object.entries(record)) {
    if (typeof actionId === "string" && typeof combo === "string") {
      normalized[actionId] = combo;
    }
  }
  return normalized;
}

function normalizeGemmaSettings(
  gemma: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["gemma"] {
  const modelSource = resolveModelSource(
    gemma?.modelSource,
    defaults.gemma.modelSource,
  );
  const resolvedVramMode = resolveGemmaVramMode(
    gemma?.vramMode,
    defaults.gemma.vramMode,
  );
  const modeDefaults = resolveModeAwareDefaults(defaults, resolvedVramMode);
  const resolvedModel = resolveStoredGemmaModel(
    gemma,
    modeDefaults,
    resolvedVramMode,
  );
  const resolvedMmproj =
    modelSource === "huggingface"
      ? resolveStoredGemmaMmproj(gemma, resolvedModel, modeDefaults)
      : {};
  const localModelPath = resolveOptionalString(gemma?.localModelPath);
  const localMmprojPath = resolveOptionalString(gemma?.localMmprojPath);
  const llamaRuntimeProfile = resolveStoredLlamaRuntimeProfile(gemma, defaults);
  const llamaRocmTarget = resolveStoredLlamaRocmTarget(
    gemma,
    defaults,
    llamaRuntimeProfile,
  );
  return {
    modelSource,
    modelRepo: resolvedModel.modelRepo,
    modelFile: resolvedModel.modelFile,
    ...(resolvedMmproj.mmprojRepo
      ? { mmprojRepo: resolvedMmproj.mmprojRepo }
      : {}),
    ...(resolvedMmproj.mmprojFile
      ? { mmprojFile: resolvedMmproj.mmprojFile }
      : {}),
    ...(localModelPath ? { localModelPath } : {}),
    ...(localMmprojPath ? { localMmprojPath } : {}),
    vramMode: resolvedVramMode,
    llamaRuntimeProfile,
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
  };
}

function resolveModeAwareDefaults(
  defaults: AppSettings,
  resolvedVramMode: GemmaVramMode,
): AppSettings {
  const modeAwareGemmaDefaults = getModeAwareGemmaDefaults(
    defaults,
    resolvedVramMode,
  );
  return {
    ...defaults,
    gemma: {
      ...defaults.gemma,
      ...modeAwareGemmaDefaults,
    },
  };
}

function normalizeCodexSettings(
  codex: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["codex"] {
  return {
    model: resolveNonEmptyString(codex?.model, defaults.codex.model),
    reasoningEffort: resolveCodexReasoningEffort(
      codex?.reasoningEffort,
      defaults.codex.reasoningEffort,
    ),
    oauthPort: resolvePortNumber(codex?.oauthPort, defaults.codex.oauthPort),
  };
}

function normalizeApiSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["api"] {
  return {
    baseUrl: resolveOpenAiCompatibleBaseUrl(api?.baseUrl, defaults.api.baseUrl),
    model: resolveNonEmptyString(api?.model, defaults.api.model),
    ...resolveApiKeySettings(api),
    ...resolveApiSamplingSettings(api, defaults),
    ...resolveApiReasoningSettings(api, defaults),
    ...resolveApiJsonSettings(api, defaults),
  };
}

function resolveApiKeySettings(
  api: Record<string, unknown> | null,
): Pick<AppSettings["api"], "apiKey"> | Record<string, never> {
  const apiKey = resolveOptionalString(api?.apiKey);
  return apiKey ? { apiKey } : {};
}

function resolveApiSamplingSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): Pick<AppSettings["api"], "temperature" | "topP" | "topK"> {
  return {
    temperature: resolveNullableNumberRange(
      api?.temperature,
      defaults.api.temperature ?? null,
      0,
      2,
    ),
    topP: resolveNullableNumberRange(
      api?.topP,
      defaults.api.topP ?? null,
      0,
      1,
    ),
    topK: resolveNullableIntegerRange(
      api?.topK,
      defaults.api.topK ?? null,
      1,
      1000,
    ),
  };
}

function resolveApiReasoningSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): Pick<AppSettings["api"], "reasoningEffort"> {
  return {
    reasoningEffort: resolveNullableReasoningEffort(
      api?.reasoningEffort,
      defaults.api.reasoningEffort ?? null,
    ),
  };
}

function resolveApiJsonSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): Pick<AppSettings["api"], "extraBodyJson" | "customHeadersJson"> {
  return {
    extraBodyJson: resolveOptionalJsonObjectString(
      api?.extraBodyJson,
      defaults.api.extraBodyJson ?? "",
    ),
    customHeadersJson: resolveOptionalJsonObjectString(
      api?.customHeadersJson,
      defaults.api.customHeadersJson ?? "",
    ),
  };
}

function normalizeOcrSettings(
  ocr: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["ocr"] {
  const hardwareVendor = inferHardwareVendorFromDefaults(defaults);
  const gpuBackend = resolveOcrGpuBackend(
    ocr?.gpuBackend,
    defaults.ocr.gpuBackend ?? "cuda",
  );
  return {
    device:
      hardwareVendor === "amd" && gpuBackend !== "rocm-transformers"
        ? "cpu"
        : resolveOcrDevice(ocr?.device, defaults.ocr.device),
    gpuBackend,
    gpuCudaTag: resolveStoredOcrGpuCudaTag(ocr, defaults),
  };
}

function normalizeUiSettings(
  ui: Record<string, unknown> | null,
  defaults: AppSettings,
): NonNullable<AppSettings["ui"]> {
  return {
    inpaintingGuideHidden: resolveBoolean(
      ui?.inpaintingGuideHidden,
      defaults.ui?.inpaintingGuideHidden ?? false,
    ),
    twoPassByDefault: resolveBoolean(
      ui?.twoPassByDefault,
      defaults.ui?.twoPassByDefault ?? true,
    ),
    analysisScopeDefault: resolveAnalysisScopeDefault(
      ui?.analysisScopeDefault,
      defaults.ui?.analysisScopeDefault ?? "missing",
    ),
  };
}

function normalizeBlockFormatDefaults(
  raw: Record<string, unknown> | null,
  defaults: AppSettings,
): NonNullable<AppSettings["blockFormatDefaults"]> {
  const base = defaults.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS;
  const data = raw ?? {};
  const fontFamily = resolveOptionalString(data.fontFamily);
  return {
    renderDirection: resolveBlockFormatDirection(
      data.renderDirection,
      base.renderDirection,
    ),
    textAlign: resolveTextAlign(data.textAlign, base.textAlign),
    ...(fontFamily ? { fontFamily } : {}),
    autoFitText: resolveBoolean(data.autoFitText, base.autoFitText),
    fontSizePx: Math.round(
      resolveNumberRange(data.fontSizePx, base.fontSizePx, 1, 512),
    ),
    lineHeight: resolveNumberRange(data.lineHeight, base.lineHeight, 0.5, 4),
    letterSpacing: resolveNumberRange(
      data.letterSpacing,
      base.letterSpacing,
      -0.5,
      2,
    ),
    textColor: resolveHexColor(data.textColor, base.textColor),
    outlineEnabled: resolveBoolean(data.outlineEnabled, base.outlineEnabled),
    outlineColor: resolveHexColor(data.outlineColor, base.outlineColor),
    outlineWidthScale: resolveNumberRange(
      data.outlineWidthScale,
      base.outlineWidthScale,
      0,
      8,
    ),
    bold: resolveBoolean(data.bold, base.bold),
    italic: resolveBoolean(data.italic, base.italic),
  };
}

function resolveBlockFormatDirection(
  value: unknown,
  fallback: BlockFormatDefaults["renderDirection"],
): BlockFormatDefaults["renderDirection"] {
  return value === "auto" || value === "horizontal" || value === "vertical"
    ? value
    : fallback;
}

function resolveTextAlign(
  value: unknown,
  fallback: BlockFormatDefaults["textAlign"],
): BlockFormatDefaults["textAlign"] {
  return value === "left" || value === "center" || value === "right"
    ? value
    : fallback;
}

function normalizeInpaintingSettings(
  inpainting: Record<string, unknown> | null,
  defaults: AppSettings,
): NonNullable<AppSettings["inpainting"]> {
  return {
    model: resolveStoredInpaintingModel(inpainting, defaults),
    fluxBackend: resolveStoredFluxBackend(inpainting, defaults),
    koharuBackend: resolveStoredKoharuInpaintingBackend(inpainting, defaults),
  };
}

export function parseStoredAppSettings(
  rawText: string | null | undefined,
  defaults = resolveDefaultAppSettings(),
): AppSettings {
  if (!rawText?.trim()) {
    return defaults;
  }

  return normalizeAppSettings(JSON.parse(rawText), defaults);
}
