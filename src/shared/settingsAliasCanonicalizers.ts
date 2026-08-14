import type {
  AmdRocmTarget,
  FluxBackend,
  GemmaVramMode,
  InpaintingModel,
  KoharuInpaintingBackend,
  LlamaRuntimeProfile,
  OcrGpuBackend,
  OcrQualityMode,
} from "./settingsTypes";

type SettingsAliasSurface = "ipc" | "runtime-stored";

const GEMMA_VRAM_MODE_ALIASES = createAliasMap<GemmaVramMode>([
  ["minimum12b", ["minimum12b", "minimum", "minimal", "min", "12b"]],
  ["economy26b", ["economy26b", "economy", "eco", "26b"]],
  ["full31b", ["full31b", "full", "31b"]],
]);

const LLAMA_RUNTIME_PROFILE_ALIASES = createAliasMap<LlamaRuntimeProfile>([
  ["rtx50", ["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"]],
  ["cuda12", ["cuda12", "cuda12.4", "cuda"]],
  ["rocm", ["rocm", "hip", "amd-rocm"]],
  ["vulkan", ["vulkan", "amd-vulkan", "vk"]],
  ["metal", ["metal", "apple", "apple-metal", "mps"]],
]);

const FLUX_BACKEND_ALIASES = createAliasMap<FluxBackend>([
  ["cuda-native", ["cuda-native", "cuda", "native", "nvidia"]],
  [
    "cuda-sm75-experimental",
    ["cuda-sm75-experimental", "cuda-sm75", "sm75-cuda", "sm75"],
  ],
  [
    "zluda-native",
    ["zluda-native", "zluda", "python-rocm", "rocm", "hip", "amd"],
  ],
  ["metal-native", ["metal-native", "metal", "apple"]],
  ["python-cpu", ["python-cpu", "cpu"]],
]);

const INPAINTING_MODEL_ALIASES = createAliasMap<InpaintingModel>([
  ["flux-klein", ["flux", "flux-klein", "klein", "default"]],
  ["lama-manga", ["koharu", "lama", "lama-manga", "lama_manga"]],
  ["aot-inpainting", ["aot", "aot-inpainting", "aot_inpainting"]],
]);

const KOHARU_BACKEND_ALIASES = createAliasMap<KoharuInpaintingBackend>([
  ["auto", ["auto", "default"]],
  ["cuda-native", ["cuda", "cuda-native", "nvidia"]],
  ["zluda-native", ["zluda", "zluda-native", "amd"]],
  ["metal-native", ["metal", "metal-native", "apple"]],
  ["cpu", ["cpu", "python-cpu"]],
]);

const OCR_GPU_BACKEND_ALIASES = createAliasMap<OcrGpuBackend>([
  ["cuda", ["cuda", "nvidia"]],
  [
    "rocm-transformers",
    ["rocm", "amd", "hip", "rocm-transformers", "transformers-rocm"],
  ],
]);

const OCR_QUALITY_MODE_ALIASES = createAliasMap<OcrQualityMode>([
  [
    "economy",
    [
      // One-way migration for the removed minimum preset.
      "minimum",
      "minimal",
      "min",
      "tiny",
      "tiny_rec",
      "tiny-rec",
      "12b",
      "최소",
      "economy",
      "eco",
      "small",
      "small_rec",
      "small-rec",
      "26b",
      "절약",
    ],
  ],
  [
    "full",
    [
      "full",
      "quality",
      "31b",
      "풀로드",
      // One-way migration for the removed CUDA legacy full preset.
      "cuda-legacy-full",
      "cuda_legacy_full",
      "cuda-legacy",
      "legacy-full",
      "legacy",
      "vl",
      "paddleocr-vl",
      "cuda 레거시 풀로드",
    ],
  ],
]);

export function canonicalizeGemmaVramMode(
  value: unknown,
): GemmaVramMode | undefined {
  return lookupAlias(GEMMA_VRAM_MODE_ALIASES, value);
}

export function canonicalizeLlamaRuntimeProfile(
  value: unknown,
): LlamaRuntimeProfile | undefined {
  return lookupAlias(LLAMA_RUNTIME_PROFILE_ALIASES, value);
}

export function canonicalizeAmdRocmTarget(
  value: unknown,
): AmdRocmTarget | undefined {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  if (normalized === "gfx908" || normalized === "gfx90a") {
    return normalized;
  }
  if (/^gfx103[0-9a-fx]*$/.test(normalized)) return "gfx103X";
  if (/^gfx110[0-9a-fx]*$/.test(normalized)) return "gfx110X";
  if (normalized === "gfx1150" || normalized === "gfx1151") {
    return normalized;
  }
  if (/^gfx120[0-9a-fx]*$/.test(normalized)) return "gfx120X";
  return undefined;
}

export function canonicalizeFluxBackend(
  value: unknown,
  surface: SettingsAliasSurface,
): FluxBackend | undefined {
  const normalized = normalizeAlias(value);
  if (surface === "ipc") {
    if (normalized === "" || normalized === "auto") return "cuda-native";
    if (normalized === "apple-metal" || normalized === "mps") {
      return "metal-native";
    }
  }
  return lookupNormalizedAlias(FLUX_BACKEND_ALIASES, normalized);
}

export function canonicalizeInpaintingModel(
  value: unknown,
  surface: SettingsAliasSurface,
): InpaintingModel | undefined {
  const normalized = normalizeAlias(value);
  if (surface === "ipc" && (normalized === "" || normalized === "auto")) {
    return "flux-klein";
  }
  return lookupNormalizedAlias(INPAINTING_MODEL_ALIASES, normalized);
}

export function canonicalizeKoharuInpaintingBackend(
  value: unknown,
  surface: SettingsAliasSurface,
): KoharuInpaintingBackend | undefined {
  const normalized = normalizeAlias(value);
  if (surface === "ipc") {
    if (normalized === "") return "auto";
    if (normalized === "apple-metal" || normalized === "mps") {
      return "metal-native";
    }
  }
  return lookupNormalizedAlias(KOHARU_BACKEND_ALIASES, normalized);
}

export function canonicalizeOcrGpuBackend(
  value: unknown,
  surface: SettingsAliasSurface,
): OcrGpuBackend | undefined {
  const normalized = normalizeAlias(value);
  if (surface === "ipc" && (normalized === "" || normalized === "auto")) {
    return "cuda";
  }
  return lookupNormalizedAlias(OCR_GPU_BACKEND_ALIASES, normalized);
}

export function canonicalizeOcrQualityMode(
  value: unknown,
): OcrQualityMode | undefined {
  return lookupAlias(OCR_QUALITY_MODE_ALIASES, value);
}

function lookupAlias<T extends string>(
  aliases: ReadonlyMap<string, T>,
  value: unknown,
): T | undefined {
  return lookupNormalizedAlias(aliases, normalizeAlias(value));
}

function lookupNormalizedAlias<T extends string>(
  aliases: ReadonlyMap<string, T>,
  normalized: string,
): T | undefined {
  return aliases.get(normalized);
}

function createAliasMap<T extends string>(
  groups: ReadonlyArray<readonly [T, readonly string[]]>,
): ReadonlyMap<string, T> {
  return new Map(
    groups.flatMap(([canonical, aliases]) =>
      aliases.map((alias): [string, T] => [alias, canonical]),
    ),
  );
}

function normalizeAlias(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}
