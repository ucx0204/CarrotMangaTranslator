import { z } from "zod";
import { CODEX_REASONING_EFFORTS } from "./codexSettings";

const codexAccountModelSchema = z
  .object({
    id: z.string().min(1).max(120),
    displayName: z.string().min(1).max(200),
    supportedReasoningEfforts: z
      .array(z.enum(CODEX_REASONING_EFFORTS))
      .min(1)
      .max(CODEX_REASONING_EFFORTS.length),
    defaultReasoningEffort: z.enum(CODEX_REASONING_EFFORTS),
    isDefault: z.boolean(),
  })
  .strict();

export const codexAccountSnapshotSchema = z
  .object({
    authenticated: z.boolean(),
    accountKind: z.enum(["chatgpt", "api-key", "amazon-bedrock"]).nullable(),
    email: z.string().max(320).nullable(),
    planType: z.string().max(120).nullable(),
    requiresOpenaiAuth: z.boolean(),
    appServerVersion: z.string().min(1).max(120),
    models: z.array(codexAccountModelSchema).max(500),
  })
  .strict();
