import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
} from "../../shared/modelPresets";
import {
  isOfficialOpenAiApiBaseUrl,
  resolveOpenAiCompatibleBaseUrl,
} from "../../shared/apiSettings";
import { CODEX_REASONING_EFFORTS } from "../../shared/codexSettings";
import type {
  ApiReasoningEffort,
  CodexReasoningEffort,
  FluxBackend,
  GemmaVramMode,
  InpaintingModel,
  KoharuInpaintingBackend,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../shared/settingsTypes";
export function resolveModelProvider(
  value: unknown,
  fallback: ModelProvider,
): ModelProvider {
  return value === "openai-api" || value === "openai-codex" || value === "gemma"
    ? value
    : fallback;
}

export { resolveOpenAiCompatibleBaseUrl };
export { isOfficialOpenAiApiBaseUrl };

export function resolveModelSource(
  value: unknown,
  fallback: ModelSource,
): ModelSource {
  return value === "local" || value === "huggingface" ? value : fallback;
}

export function resolveGemmaVramMode(
  value: unknown,
  fallback: GemmaVramMode,
): GemmaVramMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["minimum12b", "minimum", "minimal", "min", "12b"].includes(normalized)) {
    return "minimum12b";
  }
  if (["economy26b", "economy", "eco", "26b"].includes(normalized)) {
    return "economy26b";
  }
  if (["full31b", "full", "31b"].includes(normalized)) {
    return "full31b";
  }
  return fallback;
}

export function resolveOcrDevice(
  value: unknown,
  fallback: OcrDevice,
): OcrDevice {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "cpu") {
    return "cpu";
  }
  if (
    normalized === "gpu" ||
    normalized === "cuda" ||
    normalized.startsWith("gpu")
  ) {
    return "gpu";
  }
  return fallback;
}

export function resolveOcrGpuBackend(
  value: unknown,
  fallback: OcrGpuBackend = "cuda",
): OcrGpuBackend {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "cuda" || normalized === "nvidia") {
    return "cuda";
  }
  if (
    normalized === "rocm" ||
    normalized === "amd" ||
    normalized === "hip" ||
    normalized === "rocm-transformers" ||
    normalized === "transformers-rocm"
  ) {
    return "rocm-transformers";
  }
  return fallback;
}

export function resolveOcrQualityMode(
  value: unknown,
  fallback: OcrQualityMode,
): OcrQualityMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    [
      "minimum",
      "minimal",
      "min",
      "tiny",
      "tiny_rec",
      "tiny-rec",
      "12b",
      "최소",
    ].includes(normalized)
  ) {
    return "minimum";
  }
  if (
    [
      "economy",
      "eco",
      "small",
      "small_rec",
      "small-rec",
      "26b",
      "절약",
    ].includes(normalized)
  ) {
    return "economy";
  }
  if (["full", "quality", "31b", "풀로드"].includes(normalized)) {
    return "full";
  }
  if (
    [
      "cuda-legacy-full",
      "cuda_legacy_full",
      "cuda-legacy",
      "legacy-full",
      "legacy",
      "vl",
      "paddleocr-vl",
      "cuda 레거시 풀로드",
    ].includes(normalized)
  ) {
    // CUDA legacy full was removed. Migrate persisted aliases to the current
    // semantic full-quality path instead of exposing the old runtime mode.
    return "full";
  }
  return fallback;
}

export function resolveFluxBackend(
  value: unknown,
  fallback: FluxBackend = "cuda-native",
): FluxBackend {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["cuda-native", "cuda", "native", "nvidia"].includes(normalized)) {
    return "cuda-native";
  }
  if (
    ["cuda-sm75-experimental", "cuda-sm75", "sm75-cuda", "sm75"].includes(
      normalized,
    )
  ) {
    return "cuda-sm75-experimental";
  }
  if (["zluda-native", "zluda"].includes(normalized)) {
    return "zluda-native";
  }
  if (["metal-native", "metal", "apple"].includes(normalized)) {
    return "metal-native";
  }
  if (["python-rocm", "rocm", "hip", "amd"].includes(normalized)) {
    return "zluda-native";
  }
  if (["python-cpu", "cpu"].includes(normalized)) {
    return "python-cpu";
  }
  return fallback;
}

export function resolveInpaintingModel(
  value: unknown,
  fallback: InpaintingModel = "flux-klein",
): InpaintingModel {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["flux", "flux-klein", "klein", "default"].includes(normalized)) {
    return "flux-klein";
  }
  if (["koharu", "lama", "lama-manga", "lama_manga"].includes(normalized)) {
    return "lama-manga";
  }
  if (["aot", "aot-inpainting", "aot_inpainting"].includes(normalized)) {
    return "aot-inpainting";
  }
  return fallback;
}

export function resolveKoharuInpaintingBackend(
  value: unknown,
  fallback: KoharuInpaintingBackend = "auto",
): KoharuInpaintingBackend {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["auto", "default"].includes(normalized)) {
    return "auto";
  }
  if (["cuda", "cuda-native", "nvidia"].includes(normalized)) {
    return "cuda-native";
  }
  if (["zluda", "zluda-native", "amd"].includes(normalized)) {
    return "zluda-native";
  }
  if (["metal", "metal-native", "apple"].includes(normalized)) {
    return "metal-native";
  }
  if (["cpu", "python-cpu"].includes(normalized)) {
    return "cpu";
  }
  return fallback;
}

export function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function resolveNumberRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function resolveHexColor(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

export function resolveAnalysisScopeDefault(
  value: unknown,
  fallback: "work" | "missing" | "chapter",
): "work" | "missing" | "chapter" {
  return value === "work" || value === "missing" || value === "chapter"
    ? value
    : fallback;
}

export function resolveOcrGpuCudaTag(value: unknown, fallback: string): string {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (/^cu\d+$/.test(text)) {
    return text;
  }
  const digits = text.replace(/\D/g, "");
  if (digits) {
    return `cu${digits}`;
  }
  return fallback;
}

export function resolveCodexReasoningEffort(
  value: unknown,
  fallback: CodexReasoningEffort,
): CodexReasoningEffort {
  if (value === "minimal") {
    return "low";
  }
  return CODEX_REASONING_EFFORTS.some((effort) => effort === value)
    ? (value as CodexReasoningEffort)
    : fallback;
}

export function resolveNullableReasoningEffort(
  value: unknown,
  fallback: ApiReasoningEffort | null,
): ApiReasoningEffort | null {
  if (value === null || value === "") {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
    ? normalized
    : fallback;
}

export function resolveNonEmptyString(
  value: unknown,
  fallback: string,
): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function resolveOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolvePortNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return clampInteger(parsed, 1, 65535);
}

export function resolveMaxTokens(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return clampInteger(parsed, MIN_MAX_TOKENS, MAX_MAX_TOKENS);
}

export function resolveContextTokens(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(MIN_CONTEXT_TOKENS, parsed);
}

export function resolveNullableNumberRange(
  value: unknown,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  if (value === null || value === "") {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function resolveNullableIntegerRange(
  value: unknown,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  if (value === null || value === "") {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return clampInteger(parsed, min, max);
}

export function resolveOptionalJsonObjectString(
  value: unknown,
  fallback = "",
): string {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return "";
  }
  const text = String(value).trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return text;
    }
  } catch (_error) {
    return fallback;
  }
  return fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
