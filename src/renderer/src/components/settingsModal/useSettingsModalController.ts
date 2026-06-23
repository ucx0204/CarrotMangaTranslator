import React from "react";
import type { AppSettings } from "../../../../shared/settingsTypes";
import { buildSettingsFromDraft } from "./settingsModalBuildSettings";
import {
  getApiAdvancedSettingsMessage,
  isSettingsFormSubmittable,
  resolveSettingsDraft,
  type SettingsDraft,
  type SettingsFormValues,
} from "./settingsModalFormUtils";
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
  const [activeTab, setActiveTab] = React.useState<SettingsTabId>("engine");
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
            values: form.values,
          })
        : null,
    [canSubmit, draft, form.values, initialSettings],
  );
  const submit = React.useCallback(() => {
    const nextSettings = buildSettings();
    if (nextSettings && canSubmit) {
      onSubmit(nextSettings);
    }
  }, [buildSettings, canSubmit, onSubmit]);
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
    jobActive,
    localActions,
    onCancel,
    onOpenLogFolder,
    onReset,
    runModelTest,
    runtime,
    setActiveTab,
    submit,
    test,
  });
}

function buildSettingsModalViewProps({
  activeTab,
  canSubmit,
  controlsBusy,
  draft,
  form,
  jobActive,
  localActions,
  onCancel,
  onOpenLogFolder,
  onReset,
  runModelTest,
  runtime,
  setActiveTab,
  submit,
  test,
}: {
  activeTab: SettingsTabId;
  canSubmit: boolean;
  controlsBusy: boolean;
  draft: SettingsDraft;
  form: ReturnType<typeof useSettingsFormState>;
  jobActive: boolean;
  localActions: ReturnType<typeof useSettingsLocalModelActions>;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  runModelTest: () => Promise<void>;
  runtime: SettingsRuntimeGuards;
  setActiveTab: React.Dispatch<React.SetStateAction<SettingsTabId>>;
  submit: () => void;
  test: ReturnType<typeof useSettingsTestState>;
}): SettingsModalViewProps {
  return {
    activeTab,
    canSubmit,
    controlsBusy,
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
    onCancel,
    onOpenLogFolder,
    onReset,
    setActiveTab,
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
    validationProps: buildValidationProps(form.values, draft),
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
    usesNvidiaHardware: runtime.usesNvidiaHardware,
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
    inpaintingModel: form.values.inpaintingModel,
    isFluxBackendOptionDisabled: runtime.isFluxBackendOptionDisabled,
    ocrDevice: form.values.ocrDevice,
    ocrGpuBackend: form.values.ocrGpuBackend,
    setFluxBackend: form.setters.setFluxBackend,
    setInpaintingModel: form.setters.setInpaintingModel,
    setOcrDevice: form.setters.setOcrDevice,
    setOcrGpuBackend: form.setters.setOcrGpuBackend,
    usesAmdHardware: runtime.usesAmdHardware,
    usesAmdOcrContext: runtime.usesAmdOcrContext,
    usesNvidiaHardware: runtime.usesNvidiaHardware,
    usesNvidiaOcrContext: runtime.usesNvidiaOcrContext,
  };
}

function buildValidationProps(
  values: SettingsFormValues,
  draft: SettingsDraft,
): SettingsModalViewProps["validationProps"] {
  return {
    apiAdvancedSettingsMessage: getApiAdvancedSettingsMessage(draft),
    apiAdvancedSettingsValid: draft.apiAdvancedSettingsValid,
    apiBaseUrlValid: draft.apiBaseUrlValid,
    codexOauthPortValid: draft.codexOauthPortValid,
    contextTokensValid: draft.contextTokensValid,
    maxTokensValid: draft.maxTokensValid,
    modelProvider: values.modelProvider,
  };
}
