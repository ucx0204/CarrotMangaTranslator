import { z } from "zod";
import {
  MAX_API_KEYS,
  MAX_API_KEYS_TEXT_LENGTH,
  parseApiKeys,
} from "./apiKeySettings";
import { localPathResult } from "./ipcContractCore";

export const vertexServiceAccountPickResultSchema = z
  .object({
    filePath: localPathResult,
    fileName: z.string().min(1).max(500),
    projectId: z.string().min(1).max(100),
    clientEmail: z.string().email().max(320),
  })
  .strict();

const discoverableApiProviderSchema = z.enum([
  "nvidia-nim",
  "google-ai-studio",
  "google-vertex",
  "openrouter",
  "ollama",
]);

export const apiModelDiscoveryRequestSchema = z
  .object({
    provider: discoverableApiProviderSchema,
    apiKey: z
      .string()
      .max(MAX_API_KEYS_TEXT_LENGTH)
      .refine((value) => parseApiKeys(value).length <= MAX_API_KEYS),
    vertexAuthMode: z.enum(["access-token", "service-account"]).optional(),
    vertexServiceAccountPath: localPathResult.optional(),
    vertexProject: z.string().max(100).optional(),
    vertexLocation: z.string().max(100).optional(),
  })
  .strict();

export const apiModelDiscoveryResultSchema = z
  .object({
    provider: discoverableApiProviderSchema,
    models: z
      .array(
        z
          .object({
            id: z.string().min(1).max(300),
            label: z.string().min(1).max(500),
            baseUrl: z.string().url().max(2000),
          })
          .strict(),
      )
      .max(2000),
    checkedCount: z.number().int().nonnegative(),
    unverifiedCount: z.number().int().nonnegative(),
  })
  .strict();
