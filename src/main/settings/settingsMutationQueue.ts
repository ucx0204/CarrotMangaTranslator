import type { AppSettings } from "../../shared/settingsTypes";
const writes = new Map<string, Promise<unknown>>();

export async function withSettingsMutation<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = writes.get(path) ?? Promise.resolve();
  const pending = previous.then(action, action);
  writes.set(path, pending);
  try {
    return await pending;
  } finally {
    if (writes.get(path) === pending) writes.delete(path);
  }
}

export function preserveCodexPreferences(
  submitted: AppSettings,
  current: AppSettings,
): AppSettings {
  return {
    ...submitted,
    ui: {
      ...submitted.ui,
      codexTypesettingPreferences:
        current.ui?.codexTypesettingPreferences ??
        submitted.ui?.codexTypesettingPreferences,
    },
  };
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}
