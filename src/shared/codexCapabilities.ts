import type { CodexAccountSnapshot } from "./codexAccountTypes";
import type { AppSettings } from "./settingsTypes";
import { CODEX_TYPESETTING_MODEL } from "./codexTypesettingDefaults";
import { CODEX_IMAGE_MODELS } from "./codexSettings";

export function canUseCodexImages(
  settings: Pick<AppSettings, "modelProvider" | "codex"> | null,
  account: CodexAccountSnapshot | null,
): boolean {
  return codexImageAvailability(settings, account) === "available";
}

type CodexImageAvailability =
  | "checking"
  | "disconnected"
  | "model-unavailable"
  | "effort-unavailable"
  | "available";

/** Image work selects its own request model independently of text translation. */
function codexImageAvailability(
  settings: Pick<AppSettings, "codex"> | null,
  account: CodexAccountSnapshot | null,
): CodexImageAvailability {
  if (!settings || !account) return "checking";
  if (!account.authenticated || account.accountKind !== "chatgpt")
    return "disconnected";
  if (
    !CODEX_IMAGE_MODELS.some(
      (id) => id === (settings.codex.imageModel ?? CODEX_TYPESETTING_MODEL),
    )
  )
    return "model-unavailable";
  const model = account.models.find(
    (item) =>
      item.id === (settings.codex.imageModel ?? CODEX_TYPESETTING_MODEL),
  );
  if (!model) return "model-unavailable";
  return model.supportedReasoningEfforts.includes(
    settings.codex.imageReasoningEffort ?? "low",
  )
    ? "available"
    : "effort-unavailable";
}
