import type { AppSettings } from "../../shared/settingsTypes";
import {
  resolveCodexReasoningEffort,
  resolveNonEmptyString,
} from "./appSettingsResolvers";

export function normalizeCodexSettings(
  codex: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["codex"] {
  return {
    model: resolveNonEmptyString(codex?.model, defaults.codex.model),
    reasoningEffort: resolveCodexReasoningEffort(
      codex?.reasoningEffort,
      defaults.codex.reasoningEffort,
    ),
  };
}
