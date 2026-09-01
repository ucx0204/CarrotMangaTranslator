import React from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../../shared/settingsTypes";
import type { SettingsModalViewProps } from "./SettingsModalView";
import type { SettingsTabId } from "../settingsModalTypes";
import {
  useBlockFormatDefaultsDraft,
  useBlockStylePresetGroupsDraft,
  useBlockStylePresetsDraft,
  useKeybindingsDraft,
  useSettingsDraftDirty,
  useSettingsSubmission,
} from "./settingsModalDraft";
import { buildSettingsModalViewProps } from "./settingsModalViewPropsBuilder";
import { useSettingsFormState } from "./useSettingsFormState";
import { useSettingsLocalModelActions } from "./useSettingsLocalModelActions";
import { useSettingsModelTest } from "./useSettingsModelTest";
import { useSettingsRuntimeGuards } from "./useSettingsRuntimeGuards";
import { useSettingsTestState } from "./useSettingsTestState";
import type { SettingsOpenRequest } from "../../hooks/useSettingsDialog";

export type SettingsModalControllerInput = {
  initialSettings: AppSettings;
  busy: boolean;
  jobActive: boolean;
  openRequest?: SettingsOpenRequest;
  onCancel: () => void;
  onOpenErrorReport: () => void;
  onOpenLogFolder: () => void;
  onReset: () => Promise<AppSettings | null>;
  onDirtyChange?: (isDirty: boolean) => void;
  onSubmit: (settings: AppSettings) => void;
};

export function useSettingsModalController({
  initialSettings,
  busy,
  jobActive,
  openRequest,
  onCancel,
  onOpenErrorReport,
  onOpenLogFolder,
  onReset,
  onDirtyChange,
  onSubmit,
}: SettingsModalControllerInput): SettingsModalViewProps {
  const { t } = useTranslation("components");
  const state = useSettingsControllerState({
    busy,
    initialSettings,
    onDirtyChange,
    onReset,
    openRequest,
  });
  const submission = useSettingsSubmission({
    blockFormatDefaults: state.blockFormatDefaults,
    blockStylePresetGroups: state.blockStylePresetGroups,
    blockStylePresets: state.blockStylePresets,
    form: state.form,
    initialSettings: state.draftSettings,
    isDirty: state.isDirty,
    keybindings: state.keybindings,
    onSubmit,
  });
  const runModelTest = useSettingsModelTest({
    appendTestLogLine: state.test.appendTestLogLine,
    buildSettings: submission.buildSettings,
    canSubmit: submission.formValid,
    jobActive,
    modelProvider: state.form.values.modelProvider,
    setTestState: state.test.setTestState,
  });
  const formatPanelTitle = resolveFormatPanelTitle(state, t);
  return buildSettingsModalViewProps({
    activeTab: state.activeTab,
    canSubmit: submission.canSubmit,
    controlsBusy: state.controlsBusy,
    defaultsPreviewActive: state.defaultsPreviewActive,
    draft: submission.draft,
    form: state.form,
    formatPanelTitle,
    formatPanelProps: {
      activePresetId: state.activeFormatPresetId,
      presetManagerOpenRequest:
        openRequest?.target === "style-presets" ? openRequest.revision : 0,
      bubbleLayoutPaddingRatio: state.form.values.bubbleLayoutPaddingRatio,
      value: state.blockFormatDefaults,
      stylePresets: state.blockStylePresets,
      stylePresetGroups: state.blockStylePresetGroups,
      onActivePresetChange: state.setActiveFormatPresetId,
      onBubbleLayoutPaddingRatioChange:
        state.form.setters.setBubbleLayoutPaddingRatio,
      onChange: state.updateBlockFormatDefaults,
      onStylePresetsChange: state.setBlockStylePresets,
      onStylePresetGroupsChange: state.setBlockStylePresetGroups,
    },
    jobActive,
    keybindings: state.keybindings,
    localActions: state.localActions,
    onCancel,
    onOpenErrorReport,
    onOpenLogFolder,
    onReset: state.resetDraft,
    runModelTest,
    runtime: state.runtime,
    setActiveTab: state.setActiveTab,
    setKeybindings: state.setKeybindings,
    submit: submission.submit,
    test: state.test,
    t,
    formValid: submission.formValid,
  });
}

function useSettingsControllerState({
  busy,
  initialSettings,
  onDirtyChange,
  onReset,
  openRequest,
}: Pick<
  SettingsModalControllerInput,
  "busy" | "initialSettings" | "onDirtyChange" | "onReset" | "openRequest"
>) {
  const [activeTab, setActiveTab] = React.useState<SettingsTabId>("general");
  React.useEffect(() => {
    if (openRequest?.target === "style-presets") setActiveTab("format");
    else if (openRequest) setActiveTab("general");
  }, [openRequest]);
  const [activeFormatPresetId, setActiveFormatPresetId] = React.useState<
    string | null
  >(null);
  const [defaultsPreviewActive, setDefaultsPreviewActive] =
    React.useState(false);
  const [draftSettings, setDraftSettings] = React.useState(initialSettings);
  React.useEffect(() => setDraftSettings(initialSettings), [initialSettings]);
  const drafts = useSettingsCollectionDrafts(draftSettings);
  const {
    blockFormatDefaults,
    blockStylePresetGroups,
    blockStylePresets,
    keybindings,
  } = drafts;
  useClearMissingActiveFormatPreset(blockStylePresets, setActiveFormatPresetId);
  const form = useSettingsFormState(draftSettings);
  const test = useSettingsTestState(draftSettings, form.refs.testLogRef);
  const localActions = useSettingsLocalModelActions({
    clearTestState: test.clearTestState,
    setters: form.setters,
  });
  const controlsBusy = busy || localActions.localActionBusy;
  const runtime = useSettingsRuntimeGuards({
    controlsBusy,
    initialSettings: draftSettings,
    refs: form.refs,
    setters: form.setters,
    values: form.values,
  });
  const isDirty = useSettingsDraftDirty({
    blockFormatDefaults,
    blockStylePresetGroups,
    blockStylePresets,
    formValues: form.values,
    initialSettings,
    keybindings,
  });
  React.useEffect(() => onDirtyChange?.(isDirty), [isDirty, onDirtyChange]);
  const resetDraft = useSettingsDraftReset(
    onReset,
    setDraftSettings,
    setDefaultsPreviewActive,
  );
  return {
    activeFormatPresetId,
    activeTab,
    ...drafts,
    controlsBusy,
    defaultsPreviewActive,
    draftSettings,
    form,
    isDirty,
    keybindings,
    localActions,
    resetDraft,
    runtime,
    setActiveTab,
    setActiveFormatPresetId,
    test,
  };
}

function useSettingsCollectionDrafts(draftSettings: AppSettings) {
  const [keybindings, setKeybindings] = useKeybindingsDraft(draftSettings);
  const [blockFormatDefaults, updateBlockFormatDefaults] =
    useBlockFormatDefaultsDraft(draftSettings);
  const [blockStylePresets, setBlockStylePresets] =
    useBlockStylePresetsDraft(draftSettings);
  const [blockStylePresetGroups, setBlockStylePresetGroups] =
    useBlockStylePresetGroupsDraft(draftSettings);
  return {
    blockFormatDefaults,
    blockStylePresetGroups,
    blockStylePresets,
    keybindings,
    setBlockStylePresetGroups,
    setBlockStylePresets,
    setKeybindings,
    updateBlockFormatDefaults,
  };
}

function resolveFormatPanelTitle(
  state: ReturnType<typeof useSettingsControllerState>,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const preset = state.activeFormatPresetId
    ? state.blockStylePresets.find(
        (candidate) => candidate.id === state.activeFormatPresetId,
      )
    : undefined;
  return preset
    ? t("stylePresets.editorTitle", { name: preset.name })
    : t("settings.tabs.format");
}

function useClearMissingActiveFormatPreset(
  presets: ReadonlyArray<{ id: string }>,
  setActivePresetId: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  React.useEffect(() => {
    setActivePresetId((current) =>
      current && !presets.some(({ id }) => id === current) ? null : current,
    );
  }, [presets, setActivePresetId]);
}

function useSettingsDraftReset(
  onReset: SettingsModalControllerInput["onReset"],
  setDraftSettings: React.Dispatch<React.SetStateAction<AppSettings>>,
  setDefaultsPreviewActive: React.Dispatch<React.SetStateAction<boolean>>,
): () => Promise<void> {
  return React.useCallback(async () => {
    const defaults = await onReset();
    if (!defaults) return;
    setDraftSettings(defaults);
    setDefaultsPreviewActive(true);
  }, [onReset, setDefaultsPreviewActive, setDraftSettings]);
}
