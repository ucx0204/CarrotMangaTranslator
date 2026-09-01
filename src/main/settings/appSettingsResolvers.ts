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
import {
  canonicalizeFluxBackend,
  canonicalizeGemmaVramMode,
  canonicalizeInpaintingModel,
  canonicalizeKoharuInpaintingBackend,
  canonicalizeOcrGpuBackend,
  canonicalizeOcrQualityMode,
} from "../../shared/settingsAliasCanonicalizers";
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
  return canonicalizeGemmaVramMode(value) ?? fallback;
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
  return canonicalizeOcrGpuBackend(value, "runtime-stored") ?? fallback;
}

export function resolveOcrQualityMode(
  value: unknown,
  fallback: OcrQualityMode,
): OcrQualityMode {
  return canonicalizeOcrQualityMode(value) ?? fallback;
}

export function resolveFluxBackend(
  value: unknown,
  fallback: FluxBackend = "cuda-native",
): FluxBackend {
  return canonicalizeFluxBackend(value, "runtime-stored") ?? fallback;
}

export function resolveInpaintingModel(
  value: unknown,
  fallback: InpaintingModel = "flux-klein",
): InpaintingModel {
  return canonicalizeInpaintingModel(value, "runtime-stored") ?? fallback;
}

export function resolveKoharuInpaintingBackend(
  value: unknown,
  fallback: KoharuInpaintingBackend = "auto",
): KoharuInpaintingBackend {
  return (
    canonicalizeKoharuInpaintingBackend(value, "runtime-stored") ?? fallback
  );
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

export function resolveOcrPipeline(
  value: unknown,
  fallback: import("../../shared/settingsTypes").OcrPipeline,
): import("../../shared/settingsTypes").OcrPipeline {
  return value === "hayai" || value === "paddle-legacy" ? value : fallback;
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
