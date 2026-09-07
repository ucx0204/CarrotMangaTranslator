import type { CodexAccountSnapshot } from "./codexAccountTypes";
import type { AppSettings } from "./settingsTypes";
import { CODEX_TYPESETTING_MODEL } from "./codexTypesettingDefaults";

export function canUseCodexTypesetting(
  settings: Pick<AppSettings, "modelProvider" | "codex"> | null,
  account: CodexAccountSnapshot | null,
  regionImage = false,
): boolean {
  return Boolean(
    settings &&
    (regionImage || isCodexAstraConfigured(settings)) &&
    account?.authenticated &&
    account.accountKind === "chatgpt" &&
    account.models.some(
      (model) =>
        model.id === CODEX_TYPESETTING_MODEL &&
        model.supportedReasoningEfforts.includes(
          settings.codex.reasoningEffort,
        ),
    ),
  );
}

export function isCodexDelegationEnabled(
  settings: Pick<AppSettings, "modelProvider" | "codex"> | null | undefined,
): boolean {
  return (
    isCodexAstraConfigured(settings) && settings?.codex.delegateAll === true
  );
}

export function isCodexAstraConfigured(
  settings: Pick<AppSettings, "modelProvider" | "codex"> | null | undefined,
): boolean {
  return (
    settings?.modelProvider === "openai-codex" &&
    settings.codex.model === CODEX_TYPESETTING_MODEL
  );
}
