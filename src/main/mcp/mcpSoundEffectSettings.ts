import { z } from "zod/v4";
import type { AppPaths } from "../appPaths";
import { inspectStoredPublicSettings } from "../settingsPublicSnapshot";
import { asRecord } from "../settings/appSettingsResolvers";
import { normalizeBlockFormatDefaults } from "../settings/blockFormatDefaultsNormalize";
import { CODEX_TYPESETTING_MODEL } from "../../shared/codexTypesettingDefaults";
import {
  CODEX_REASONING_EFFORTS,
  isCodexImageModel,
} from "../../shared/codexSettings";
import { CodexImageGenerationModelSchema } from "../../shared/codexSettingsSchemas";
import { McpEditError } from "../application/mcpEditPolicy";
import { normalizeImageReview } from "../settings/claudePreferences";

/** No secret decoding, login, runtime start or settings writes on discovery. */
export async function readMcpSoundEffectSettings(
  paths: AppPaths,
  expectedModel?: string,
  purpose: "generate" | "verify" = "generate",
) {
  const settings = await inspectStoredPublicSettings(paths, (record) => ({
    imageReview: normalizeImageReview(record.imageReview),
    codex: z
      .object({
        imageModel: z.string().min(1).default(CODEX_TYPESETTING_MODEL),
        imageGenerationModel: CodexImageGenerationModelSchema.default(
          "gpt-image-2.6-flare",
        ),
        imageReasoningEffort: z.enum(CODEX_REASONING_EFFORTS).default("low"),
      })
      .parse(record.codex === undefined ? {} : record.codex),
    defaults: normalizeBlockFormatDefaults(
      asRecord(record.blockFormatDefaults),
      {},
    ),
  }));
  if (
    expectedModel !== undefined &&
    (purpose === "verify" && settings.imageReview.provider === "claude"
      ? settings.imageReview.claude.model !== expectedModel
      : settings.codex.imageModel !== expectedModel ||
        !isCodexImageModel(expectedModel))
  )
    throw new McpEditError(
      "invalid_edit",
      "Requested image controller must match the configured supported app model; no fallback.",
    );
  return settings;
}
