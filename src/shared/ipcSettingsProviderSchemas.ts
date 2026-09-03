import { z } from "zod";
import {
  ApiReasoningEffortSchema,
  CustomHeadersJsonObjectStringSchema,
  JsonObjectStringSchema,
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
  OpenAiCompatibleBaseUrlSchema,
  filePath,
} from "./ipcSchemaPrimitives";
import {
  MAX_API_KEY_MAX_ATTEMPTS,
  MAX_API_KEYS,
  MAX_API_KEYS_TEXT_LENGTH,
  MAX_API_RETRY_DELAY_SECONDS,
  MIN_API_KEY_MAX_ATTEMPTS,
  MIN_API_RETRY_DELAY_SECONDS,
} from "./apiKeySettings";
import { API_PROVIDER_PRESET_IDS } from "./apiProviderPresets";

export const ApiProviderPresetSchema = z.enum(API_PROVIDER_PRESET_IDS);

export const GenerationLimitSettingsSchema = z
  .object({
    maxTokens: z.number().int().min(MIN_MAX_TOKENS).max(MAX_MAX_TOKENS),
    contextTokens: z.number().int().min(MIN_CONTEXT_TOKENS),
  })
  .strict();

export const ApiProviderProfileSettingsSchema = z
  .object({
    baseUrl: OpenAiCompatibleBaseUrlSchema,
    model: z.string().min(1).max(200),
    apiKey: z.string().max(MAX_API_KEYS_TEXT_LENGTH).optional(),
    apiKeyCount: z.number().int().min(0).max(MAX_API_KEYS).optional(),
    vertexAuthMode: z.enum(["access-token", "service-account"]).optional(),
    vertexServiceAccountPath: filePath.optional(),
    keyMaxAttempts: z
      .number()
      .int()
      .min(MIN_API_KEY_MAX_ATTEMPTS)
      .max(MAX_API_KEY_MAX_ATTEMPTS)
      .optional(),
    retryDelaySeconds: z
      .number()
      .min(MIN_API_RETRY_DELAY_SECONDS)
      .max(MAX_API_RETRY_DELAY_SECONDS)
      .optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    topP: z.number().min(0).max(1).nullable().optional(),
    topK: z.number().int().min(1).max(1000).nullable().optional(),
    reasoningEffort: ApiReasoningEffortSchema.nullable().optional(),
    extraBodyJson: JsonObjectStringSchema.optional(),
    customHeadersJson: CustomHeadersJsonObjectStringSchema.optional(),
  })
  .strict();

export function apiProviderProfileMapSchema<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      custom: value.optional(),
      "nvidia-nim": value.optional(),
      "google-ai-studio": value.optional(),
      "google-vertex": value.optional(),
      openrouter: value.optional(),
      ollama: value.optional(),
    })
    .strict();
}
