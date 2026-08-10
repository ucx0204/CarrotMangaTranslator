import React from "react";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../../../../shared/blockFormat";
import {
  cloneBlockStylePresetGroups,
  cloneBlockStylePresets,
  type BlockStylePreset,
  type BlockStylePresetGroup,
} from "../../../../shared/blockStylePresets";
import type { KeybindingOverrides } from "../../../../shared/shortcutSettings";
import type {
  AppSettings,
  BlockFormatDefaults,
} from "../../../../shared/settingsTypes";
import { buildSettingsFromDraft } from "./settingsModalBuildSettings";
import {
  isSettingsFormSubmittable,
  resolveSettingsDraft,
  type SettingsDraft,
} from "./settingsModalFormUtils";
import {
  createSettingsFormValues,
  type SettingsFormValues,
} from "./settingsModalFormValues";
import type { useSettingsFormState } from "./useSettingsFormState";

export function useSettingsSubmission({
  blockFormatDefaults,
  blockStylePresetGroups,
  blockStylePresets,
  form,
  initialSettings,
  isDirty,
  keybindings,
  onSubmit,
}: {
  blockFormatDefaults: BlockFormatDefaults;
  blockStylePresetGroups: BlockStylePresetGroup[];
  blockStylePresets: BlockStylePreset[];
  form: ReturnType<typeof useSettingsFormState>;
  initialSettings: AppSettings;
  isDirty: boolean;
  keybindings: KeybindingOverrides;
  onSubmit: (settings: AppSettings) => void;
}): {
  draft: SettingsDraft;
  canSubmit: boolean;
  formValid: boolean;
  buildSettings: () => AppSettings | null;
  submit: () => void;
} {
  const draft = React.useMemo(
    () => resolveSettingsDraft(form.values),
    [form.values],
  );
  const formValid = React.useMemo(
    () => isSettingsFormSubmittable(form.values, draft),
    [draft, form.values],
  );
  const canSubmit = formValid && isDirty;
  const buildSettings = React.useCallback(
    () =>
      formValid
        ? buildSettingsFromDraft({
            draft,
            initialSettings,
            keybindings,
            blockFormatDefaults,
            blockStylePresetGroups,
            blockStylePresets,
            values: form.values,
          })
        : null,
    [
      blockFormatDefaults,
      blockStylePresetGroups,
      blockStylePresets,
      draft,
      form.values,
      formValid,
      initialSettings,
      keybindings,
    ],
  );
  const submit = React.useCallback(() => {
    const nextSettings = buildSettings();
    if (nextSettings && canSubmit) onSubmit(nextSettings);
  }, [buildSettings, canSubmit, onSubmit]);
  return { draft, canSubmit, formValid, buildSettings, submit };
}

export function useSettingsDraftDirty({
  blockFormatDefaults,
  blockStylePresetGroups,
  blockStylePresets,
  formValues,
  initialSettings,
  keybindings,
}: {
  blockFormatDefaults: BlockFormatDefaults;
  blockStylePresetGroups: BlockStylePresetGroup[];
  blockStylePresets: BlockStylePreset[];
  formValues: SettingsFormValues;
  initialSettings: AppSettings;
  keybindings: KeybindingOverrides;
}): boolean {
  return React.useMemo(
    () =>
      JSON.stringify({
        blockFormatDefaults,
        blockStylePresetGroups,
        blockStylePresets,
        formValues,
        keybindings,
      }) !==
      JSON.stringify({
        blockFormatDefaults:
          initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
        blockStylePresetGroups: cloneBlockStylePresetGroups(
          initialSettings.blockStylePresetGroups ?? [],
        ),
        blockStylePresets: cloneBlockStylePresets(
          initialSettings.blockStylePresets ?? [],
        ),
        formValues: createSettingsFormValues(initialSettings),
        keybindings: initialSettings.keybindings ?? {},
      }),
    [
      blockFormatDefaults,
      blockStylePresetGroups,
      blockStylePresets,
      formValues,
      initialSettings,
      keybindings,
    ],
  );
}

export function useBlockStylePresetGroupsDraft(
  initialSettings: AppSettings,
): [
  BlockStylePresetGroup[],
  React.Dispatch<React.SetStateAction<BlockStylePresetGroup[]>>,
] {
  const [groups, setGroups] = React.useState<BlockStylePresetGroup[]>(() =>
    cloneBlockStylePresetGroups(initialSettings.blockStylePresetGroups ?? []),
  );
  React.useEffect(() => {
    setGroups(
      cloneBlockStylePresetGroups(initialSettings.blockStylePresetGroups ?? []),
    );
  }, [initialSettings]);
  return [groups, setGroups];
}

export function useBlockStylePresetsDraft(
  initialSettings: AppSettings,
): [
  BlockStylePreset[],
  React.Dispatch<React.SetStateAction<BlockStylePreset[]>>,
] {
  const [presets, setPresets] = React.useState<BlockStylePreset[]>(() =>
    cloneBlockStylePresets(initialSettings.blockStylePresets ?? []),
  );
  React.useEffect(() => {
    setPresets(cloneBlockStylePresets(initialSettings.blockStylePresets ?? []));
  }, [initialSettings]);
  return [presets, setPresets];
}

export function useBlockFormatDefaultsDraft(
  initialSettings: AppSettings,
): [BlockFormatDefaults, (patch: Partial<BlockFormatDefaults>) => void] {
  const [draft, setDraft] = React.useState<BlockFormatDefaults>(
    () => initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
  );
  React.useEffect(() => {
    setDraft(
      initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
    );
  }, [initialSettings]);
  const update = React.useCallback(
    (patch: Partial<BlockFormatDefaults>) =>
      setDraft((current) => ({ ...current, ...patch })),
    [],
  );
  return [draft, update];
}

export function useKeybindingsDraft(
  initialSettings: AppSettings,
): [
  KeybindingOverrides,
  React.Dispatch<React.SetStateAction<KeybindingOverrides>>,
] {
  const [keybindings, setKeybindings] = React.useState<KeybindingOverrides>(
    () => initialSettings.keybindings ?? {},
  );
  React.useEffect(() => {
    setKeybindings(initialSettings.keybindings ?? {});
  }, [initialSettings]);
  return [keybindings, setKeybindings];
}
