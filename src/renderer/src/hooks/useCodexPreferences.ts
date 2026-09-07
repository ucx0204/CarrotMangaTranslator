import React from "react";
import type { CodexTypesettingPreferences } from "../../../shared/codexTypesettingTypes";
import { createCodexTypesettingPreferences } from "../../../shared/codexTypesettingDefaults";
import { codexTypesettingPreferencesSchema } from "../../../shared/codexTypesettingSchemas";
import { settingsGateway } from "../api/settingsGateway";

type Save = (
  value: CodexTypesettingPreferences,
) => Promise<CodexTypesettingPreferences>;

export function useCodexPreferences(
  saved: CodexTypesettingPreferences | undefined,
  language: string,
  enabled: boolean,
  save: Save = settingsGateway.saveCodexTypesettingPreferences,
) {
  const [value, setValue] = React.useState(() =>
    structuredClone(saved ?? createCodexTypesettingPreferences(language)),
  );
  const [error, setError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const state = React.useRef({
    value,
    revision: 0,
    savedRevision: 0,
    selectionRevision: 0,
    save,
    pending: null as Promise<boolean> | null,
  });
  React.useLayoutEffect(() => {
    state.current.save = save;
  }, [save]);
  const flush = React.useCallback(async (): Promise<boolean> => {
    const current = state.current;
    while (current.pending) {
      if (!(await current.pending)) return false;
    }
    if (current.revision === current.savedRevision) return true;
    const snapshot = codexTypesettingPreferencesSchema.safeParse(current.value);
    if (!snapshot.success) {
      setError(true);
      return false;
    }
    const revision = current.revision;
    setBusy(true);
    const pending = current
      .save(snapshot.data)
      .then(() => {
        current.savedRevision = revision;
        setError(false);
        return true;
      })
      .catch((cause: unknown) => {
        console.error("Codex font preferences could not be saved", cause);
        setError(true);
        return false;
      })
      .finally(() => {
        current.pending = null;
        setBusy(false);
      });
    current.pending = pending;
    if (!(await pending)) return false;
    return current.savedRevision === current.revision ? true : flush();
  }, []);
  const change = React.useCallback((next: CodexTypesettingPreferences) => {
    state.current.value = next;
    state.current.revision += 1;
    setValue(next);
  }, []);
  usePreferencesAutosave(enabled, value, flush);
  return {
    value: { ...value, enabled },
    setValue: change,
    flush,
    selectPreset: async (id: string) => {
      const request = ++state.current.selectionRevision;
      if (!(await flush()) || request !== state.current.selectionRevision)
        return;
      change({ ...state.current.value, selectedPresetId: id });
      await flush();
    },
    error,
    busy,
    valid:
      !enabled || codexTypesettingPreferencesSchema.safeParse(value).success,
  };
}

function usePreferencesAutosave(
  enabled: boolean,
  value: CodexTypesettingPreferences,
  flush: () => Promise<boolean>,
) {
  React.useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void flush(), 500);
    return () => window.clearTimeout(timer);
  }, [enabled, flush, value]);
}
