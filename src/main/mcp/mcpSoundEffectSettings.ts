import { z } from "zod/v4";
import type { AppPaths } from "../appPaths";
import { inspectStoredPublicSettings } from "../settingsPublicSnapshot";
import { asRecord } from "../settings/appSettingsResolvers";
import { normalizeBlockFormatDefaults } from "../settings/blockFormatDefaultsNormalize";
import { CODEX_TYPESETTING_MODEL } from "../../shared/codexTypesettingDefaults";
import { CODEX_REASONING_EFFORTS } from "../../shared/codexSettings";

/** No migrations, secret decoding, login, runtime start or settings writes on discovery. */
export function readMcpSoundEffectSettings(paths: AppPaths) {
  return inspectStoredPublicSettings(paths, (record) => ({
    codex: z
      .object({
        imageModel: z.string().min(1).default(CODEX_TYPESETTING_MODEL),
        imageReasoningEffort: z.enum(CODEX_REASONING_EFFORTS).default("low"),
      })
      .parse(record.codex === undefined ? {} : record.codex),
    defaults: normalizeBlockFormatDefaults(
      asRecord(record.blockFormatDefaults),
      {},
    ),
  }));
}
