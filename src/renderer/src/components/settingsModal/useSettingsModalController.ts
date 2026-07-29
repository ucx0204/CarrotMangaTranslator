import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  BlockFormatDefaults,
} from "../../../../shared/settingsTypes";
import type { KeybindingOverrides } from "../../../../shared/shortcutSettings";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../../../../shared/blockFormat";
import { buildSettingsFromDraft } from "./settingsModalBuildSettings";
import {
  getApiAdvancedSettingsMessage,
  isSettingsFormSubmittable,
  resolveSettingsDraft,
  type SettingsDraft,
} from "./settingsModalFormUtils";
import type { SettingsFormValues } from "./settingsModalFormValues";
import type { SettingsFormSetters } from "./useSettingsFormState";
import { useSettingsFormState } from "./useSettingsFormState";
import { useSettingsLocalModelActions } from "./useSettingsLocalModelActions";
import { useSettingsModelTest } from "./useSettingsModelTest";
import {
  type SettingsRuntimeGuards,
  useSettingsRuntimeGuards,
} from "./useSettingsRuntimeGuards";
import { useSettingsTestState } from "./useSettingsTestState";
import type { SettingsModalViewProps } from "./SettingsModalView";
import type { SettingsTabId } from "../settingsModalTypes";

export type SettingsModalControllerInput = {
  initialSettings: AppSettings;
  busy: boolean;
  jobActive: boolean;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  onSubmit: (settings: AppSettings) => void;
};

export function useSettingsModalController({
  initialSettings,
  busy,
  jobActive,
  onCancel,
  onOpenLogFolder,
  onReset,
  onSubmit,
}: SettingsModalControllerInput): SettingsModalViewProps {
  const { t } = useTranslation("components");
  const [activeTab, setActiveTab] = React.useState<SettingsTabId>("general");
  const [keybindings, setKeybindings] = useKeybindingsDraft(initialSettings);
  const [blockFormatDefaults, updateBlockFormatDefaults] =
    useBlockFormatDefaultsDraft(initialSettings);
  const form = useSettingsFormState(initialSettings);
  const test = useSettingsTestState(initialSettings, form.refs.testLogRef);
  const localActions = useSettingsLocalModelActions({
    clearTestState: test.clearTestState,
    setters: form.setters,
  });
  const controlsBusy =
    busy || localActions.localActionBusy || test.testState.status === "running";
  const runtime = useSettingsRuntimeGuards({
    controlsBusy,
    initialSettings,
    refs: form.refs,
    setters: form.setters,
    values: form.values,
  });
  const { draft, canSubmit, buildSettings, submit } = useSettingsSubmission({
    blockFormatDefaults,
    form,
    initialSettings,
    keybindings,
    onSubmit,
  });
  const runModelTest = useSettingsModelTest({
    appendTestLogLine: test.appendTestLogLine,
    buildSettings,
    canSubmit,
    jobActive,
    modelProvider: form.values.modelProvider,
    setTestState: test.setTestState,
  });

  return buildSettingsModalViewProps({
    activeTab,
    canSubmit,
    controlsBusy,
    draft,
    form,
    formatPanelProps: {
      bubbleLayoutPaddingRatio: form.values.bubbleLayoutPaddingRatio,
      value: blockFormatDefaults,
      onBubbleLayoutPaddingRatioChange:
        form.setters.setBubbleLayoutPaddingRatio,
      onChange: updateBlockFormatDefaults,
    },
    jobActive,
    keybindings,
    localActions,
    onCancel,
    onOpenLogFolder,
    onReset,
    runModelTest,
    runtime,
    setActiveTab,
    setKeybindings,
    submit,
    test,
    t,
  });
}

function useSettingsSubmission({
  blockFormatDefaults,
  form,
  initialSettings,
  keybindings,
  onSubmit,
}: {
  blockFormatDefaults: BlockFormatDefaults;
  form: ReturnType<typeof useSettingsFormState>;
  initialSettings: AppSettings;
  keybindings: KeybindingOverrides;
  onSubmit: (settings: AppSettings) => void;
}): {
  draft: SettingsDraft;
  canSubmit: boolean;
  buildSettings: () => AppSettings | null;
  submit: () => void;
} {
  const draft = React.useMemo(
    () => resolveSettingsDraft(form.values),
    [form.values],
  );
  const canSubmit = React.useMemo(
    () => isSettingsFormSubmittable(form.values, draft),
    [draft, form.values],
  );
  const buildSettings = React.useCallback(
    () =>
      canSubmit
        ? buildSettingsFromDraft({
            draft,
            initialSettings,
            keybindings,
            blockFormatDefaults,
            values: form.values,
          })
        : null,
    [
      blockFormatDefaults,
      canSubmit,
      draft,
      form.values,
      initialSettings,
      keybindings,
    ],
  );
  const submit = React.useCallback(() => {
    const nextSettings = buildSettings();
    if (nextSettings && canSubmit) {
      onSubmit(nextSettings);
    }
  }, [buildSettings, canSubmit, onSubmit]);
  return { draft, canSubmit, buildSettings, submit };
}

function useBlockFormatDefaultsDraft(
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

function useKeybindingsDraft(
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

type SettingsModalViewPropsInput = {
  activeTab: SettingsTabId;
  canSubmit: boolean;
  controlsBusy: boolean;
  draft: SettingsDraft;
  form: ReturnType<typeof useSettingsFormState>;
  formatPanelProps: SettingsModalViewProps["formatPanelProps"];
  jobActive: boolean;
  keybindings: KeybindingOverrides;
  localActions: ReturnType<typeof useSettingsLocalModelActions>;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  runModelTest: () => Promise<void>;
  runtime: SettingsRuntimeGuards;
  setActiveTab: React.Dispatch<React.SetStateAction<SettingsTabId>>;
  setKeybindings: React.Dispatch<React.SetStateAction<KeybindingOverrides>>;
  submit: () => void;
  test: ReturnType<typeof useSettingsTestState>;
  t: TFunction<"components">;
};

function buildSettingsModalViewProps({
  activeTab,
  canSubmit,
  controlsBusy,
  draft,
  form,
  formatPanelProps,
  jobActive,
  keybindings,
  localActions,
  onCancel,
  onOpenLogFolder,
  onReset,
  runModelTest,
  runtime,
  setActiveTab,
  setKeybindings,
  submit,
  test,
  t,
}: SettingsModalViewPropsInput): SettingsModalViewProps {
  return {
    activeTab,
    canSubmit,
    controlsBusy,
    generalPanelProps: {
      disabled: controlsBusy,
      locale: form.values.uiLocale,
      onLocaleChange: form.setters.setUiLocale,
    },
    enginePanelProps: buildEnginePanelProps({
      controlsBusy,
      form,
      localActions,
      runtime,
      submit,
      test,
    }),
    hardwarePanelProps: buildHardwarePanelProps({
      controlsBusy,
      form,
      runtime,
      test,
    }),
    formatPanelProps,
    onCancel,
    onOpenLogFolder,
    onReset,
    setActiveTab,
    shortcutsPanelProps: {
      onChange: setKeybindings,
      overrides: keybindings,
    },
    submit,
    testPanelProps: {
      canSubmit,
      controlsBusy,
      jobActive,
      runModelTest,
      testLogLines: test.testLogLines,
      testLogRef: test.testLogRef,
      testState: test.testState,
    },
    validationProps: buildValidationProps(form.values, draft, t),
  };
}

function buildEnginePanelProps({
  controlsBusy,
  form,
  localActions,
  runtime,
  submit,
  test,
}: {
  controlsBusy: boolean;
  form: ReturnType<typeof useSettingsFormState>;
  localActions: ReturnType<typeof useSettingsLocalModelActions>;
  runtime: SettingsRuntimeGuards;
  submit: () => void;
  test: ReturnType<typeof useSettingsTestState>;
}): SettingsModalViewProps["enginePanelProps"] {
  const { refs, setters, values } = form;
  return {
    clearTestState: test.clearTestState,
    controlsBusy,
    isLlamaRuntimeOptionDisabled: runtime.isLlamaRuntimeOptionDisabled,
    localModelInputRef: refs.localModelInputRef,
    modelRepoInputRef: refs.modelRepoInputRef,
    pickLocalMmprojFile: localActions.pickLocalMmprojFile,
    pickLocalModelFile: localActions.pickLocalModelFile,
    submit,
    usesAmdHardware: runtime.usesAmdHardware,
    usesAppleHardware: runtime.usesAppleHardware,
    usesNvidiaHardware: runtime.usesNvidiaHardware,
    unifiedMemoryMb: runtime.unifiedMemoryMb,
    ...values,
    ...setters,
  };
}

function buildHardwarePanelProps({
  controlsBusy,
  form,
  runtime,
  test,
}: {
  controlsBusy: boolean;
  form: { setters: SettingsFormSetters; values: SettingsFormValues };
  runtime: SettingsRuntimeGuards;
  test: ReturnType<typeof useSettingsTestState>;
}): SettingsModalViewProps["hardwarePanelProps"] {
  return {
    clearTestState: test.clearTestState,
    controlsBusy,
    fluxBackend: form.values.fluxBackend,
    allowUnsafeLowMemoryFlux: form.values.allowUnsafeLowMemoryFlux,
    inpaintingModel: form.values.inpaintingModel,
    isFluxBackendOptionDisabled: runtime.isFluxBackendOptionDisabled,
    ocrDevice: form.values.ocrDevice,
    ocrGpuBackend: form.values.ocrGpuBackend,
    ocrQualityMode: form.values.ocrQualityMode,
    setFluxBackend: form.setters.setFluxBackend,
    setAllowUnsafeLowMemoryFlux: form.setters.setAllowUnsafeLowMemoryFlux,
    setInpaintingModel: form.setters.setInpaintingModel,
    setOcrDevice: form.setters.setOcrDevice,
    setOcrGpuBackend: form.setters.setOcrGpuBackend,
    setOcrQualityMode: form.setters.setOcrQualityMode,
    usesAmdHardware: runtime.usesAmdHardware,
    usesAppleHardware: runtime.usesAppleHardware,
    usesAmdOcrContext: runtime.usesAmdOcrContext,
    usesNvidiaHardware: runtime.usesNvidiaHardware,
    usesNvidiaOcrContext: runtime.usesNvidiaOcrContext,
    unifiedMemoryMb: runtime.unifiedMemoryMb,
  };
}

function buildValidationProps(
  values: SettingsFormValues,
  draft: SettingsDraft,
  t: TFunction<"components">,
): SettingsModalViewProps["validationProps"] {
  return {
    apiAdvancedSettingsMessage: getApiAdvancedSettingsMessage(draft, t),
    apiAdvancedSettingsValid: draft.apiAdvancedSettingsValid,
    apiBaseUrlValid: draft.apiBaseUrlValid,
    codexOauthPortValid: draft.codexOauthPortValid,
    contextTokensValid: draft.contextTokensValid,
    maxTokensValid: draft.maxTokensValid,
    modelProvider: values.modelProvider,
    sourceLanguageValid: draft.sourceLanguageValid,
    targetLanguageValid: draft.targetLanguageValid,
  };
}
