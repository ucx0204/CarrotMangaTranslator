import {
  GEMMA_12B_MMPROJ_FILE,
  GEMMA_12B_MMPROJ_REPO,
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_26B_MMPROJ_FILE,
  GEMMA_26B_MMPROJ_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
  GEMMA_31B_MMPROJ_FILE,
  GEMMA_31B_MMPROJ_REPO,
  GEMMA_31B_MODEL_FILE_IQ3_S,
  GEMMA_31B_MODEL_REPO,
} from "../../shared/modelPresets";
import type { AppSettings, GemmaVramMode } from "../../shared/types";

type GemmaModelPreset = Pick<
  AppSettings["gemma"],
  "modelRepo" | "modelFile" | "mmprojRepo" | "mmprojFile"
>;

export function getDefaultGemmaPresetForVramMode(
  vramMode: GemmaVramMode,
): GemmaModelPreset {
  if (vramMode === "minimum12b") {
    return {
      modelRepo: GEMMA_12B_MODEL_REPO,
      modelFile: GEMMA_12B_MODEL_FILE_Q4_K_M,
      mmprojRepo: GEMMA_12B_MMPROJ_REPO,
      mmprojFile: GEMMA_12B_MMPROJ_FILE,
    };
  }
  if (vramMode === "economy26b") {
    return {
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
      mmprojRepo: GEMMA_26B_MMPROJ_REPO,
      mmprojFile: GEMMA_26B_MMPROJ_FILE,
    };
  }
  return {
    modelRepo: GEMMA_31B_MODEL_REPO,
    modelFile: GEMMA_31B_MODEL_FILE_IQ3_S,
    mmprojRepo: GEMMA_31B_MMPROJ_REPO,
    mmprojFile: GEMMA_31B_MMPROJ_FILE,
  };
}

export function getModeAwareGemmaDefaults(
  defaults: AppSettings,
  vramMode: GemmaVramMode,
): GemmaModelPreset {
  const currentDefaultModel = {
    modelRepo: defaults.gemma.modelRepo,
    modelFile: defaults.gemma.modelFile,
  };
  if (!isBuiltInGemmaModel(currentDefaultModel)) {
    return {
      modelRepo: defaults.gemma.modelRepo,
      modelFile: defaults.gemma.modelFile,
      mmprojRepo: defaults.gemma.mmprojRepo,
      mmprojFile: defaults.gemma.mmprojFile,
    };
  }
  return getDefaultGemmaPresetForVramMode(vramMode);
}

export function resolveRuntimeGemmaSettings(
  gemma: AppSettings["gemma"],
  vramMode: GemmaVramMode,
): AppSettings["gemma"] {
  if (gemma.modelSource !== "huggingface") {
    return gemma;
  }

  const model = { modelRepo: gemma.modelRepo, modelFile: gemma.modelFile };
  if (!isBuiltInGemmaModel(model)) {
    return gemma;
  }

  return {
    ...gemma,
    ...getDefaultGemmaPresetForVramMode(vramMode),
  };
}

export function isBuiltInGemmaModel(
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">,
): boolean {
  return (
    is12BGemmaModel(model) || is26BGemmaModel(model) || is31BGemmaModel(model)
  );
}

export function isMainlineGemmaModel(
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">,
): boolean {
  return is12BGemmaModel(model) || is26BGemmaModel(model);
}

function is12BGemmaModel(
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">,
): boolean {
  return (
    model.modelRepo === GEMMA_12B_MODEL_REPO &&
    model.modelFile === GEMMA_12B_MODEL_FILE_Q4_K_M
  );
}

function is31BGemmaModel(
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">,
): boolean {
  return (
    model.modelRepo === GEMMA_31B_MODEL_REPO &&
    model.modelFile === GEMMA_31B_MODEL_FILE_IQ3_S
  );
}

function is26BGemmaModel(
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">,
): boolean {
  return (
    model.modelRepo === GEMMA_26B_MODEL_REPO &&
    model.modelFile === GEMMA_26B_MODEL_FILE_IQ3_S
  );
}

export function getDefaultMmprojForGemmaModel(
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">,
): Pick<AppSettings["gemma"], "mmprojRepo" | "mmprojFile"> | undefined {
  if (is12BGemmaModel(model)) {
    return {
      mmprojRepo: GEMMA_12B_MMPROJ_REPO,
      mmprojFile: GEMMA_12B_MMPROJ_FILE,
    };
  }
  if (is26BGemmaModel(model)) {
    return {
      mmprojRepo: GEMMA_26B_MMPROJ_REPO,
      mmprojFile: GEMMA_26B_MMPROJ_FILE,
    };
  }
  if (is31BGemmaModel(model)) {
    return {
      mmprojRepo: GEMMA_31B_MMPROJ_REPO,
      mmprojFile: GEMMA_31B_MMPROJ_FILE,
    };
  }
  return undefined;
}

export function isBuiltInGemmaMmproj(
  mmprojRepo?: string,
  mmprojFile?: string,
): boolean {
  return (
    (mmprojRepo === GEMMA_31B_MMPROJ_REPO &&
      mmprojFile === GEMMA_31B_MMPROJ_FILE) ||
    (mmprojRepo === GEMMA_26B_MMPROJ_REPO &&
      mmprojFile === GEMMA_26B_MMPROJ_FILE) ||
    (mmprojRepo === GEMMA_12B_MMPROJ_REPO &&
      mmprojFile === GEMMA_12B_MMPROJ_FILE)
  );
}
