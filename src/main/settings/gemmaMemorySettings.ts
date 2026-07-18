import type { AppSettings } from "../../shared/settingsTypes";
import { resolveBoolean } from "./appSettingsResolvers";

export function resolveUnsafeUnifiedMemorySetting(
  gemma: Record<string, unknown> | null,
  defaults: AppSettings,
): Pick<AppSettings["gemma"], "allowUnsafeUnifiedMemory"> {
  return resolveBoolean(
    gemma?.allowUnsafeUnifiedMemory,
    defaults.gemma.allowUnsafeUnifiedMemory ?? false,
  )
    ? { allowUnsafeUnifiedMemory: true }
    : {};
}
