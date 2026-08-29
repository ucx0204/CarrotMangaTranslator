import type React from "react";
import type { TFunction } from "i18next";
import type { KeybindingOverrides } from "../../../../shared/shortcutSettings";
import {
  getApiAdvancedSettingsMessage,
  type SettingsDraft,
} from "./settingsModalFormUtils";
import type { SettingsFormValues } from "./settingsModalFormValues";
import type { SettingsModalViewProps } from "./SettingsModalView";
import type { SettingsTabId } from "../settingsModalTypes";
import type { useSettingsFormState } from "./useSettingsFormState";
import type { useSettingsLocalModelActions } from "./useSettingsLocalModelActions";
import type { SettingsRuntimeGuards } from "./useSettingsRuntimeGuards";
import type { useSettingsTestState } from "./useSettingsTestState";

type SettingsModalViewPropsInput = {
  activeTab: SettingsTabId;
  canSubmit: boolean;
  controlsBusy: boolean;
  defaultsPreviewActive: boolean;
  draft: SettingsDraft;
  form: ReturnType<typeof useSettingsFormState>;
  formValid: boolean;
  formatPanelTitle: string;
  formatPanelProps: SettingsModalViewProps["formatPanelProps"];
  jobActive: boolean;
  keybindings: KeybindingOverrides;
  localActions: ReturnType<typeof useSettingsLocalModelActions>;
  onCancel: () => void;
  onOpenErrorReport: () => void;
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

export function buildSettingsModalViewProps({
  activeTab,
  canSubmit,
  controlsBusy,
  defaultsPreviewActive,
  draft,
  form,
  formValid,
  formatPanelTitle,
  formatPanelProps,
  jobActive,
  keybindings,
  localActions,
  onCancel,
  onOpenErrorReport,
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
  const enginePanelProps = buildEnginePanelProps({
    controlsBusy,
    form,
    localActions,
    runtime,
    submit,
    test,
  });
  return {
    activeTab,
    canSubmit,
    controlsBusy,
    defaultsPreviewActive,
    generalPanelProps: buildGeneralPanelProps(controlsBusy, form),
    enginePanelProps,
    researchPanelProps: buildResearchPanelProps({
      controlsBusy,
      enginePanelProps,
      form,
      submit,
      test,
    }),
    hardwarePanelProps: buildHardwarePanelProps({
      controlsBusy,
      form,
      runtime,
      test,
    }),
    formatPanelTitle,
    formatPanelProps,
    onCancel,
    onOpenErrorReport,
    onOpenLogFolder,
    onReset,
    setActiveTab,
    shortcutsPanelProps: {
      onChange: setKeybindings,
      overrides: keybindings,
    },
    submit,
    testPanelProps: {
      canSubmit: formValid,
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

function buildGeneralPanelProps(
  controlsBusy: boolean,
  form: ReturnType<typeof useSettingsFormState>,
): SettingsModalViewProps["generalPanelProps"] {
  return {
    disabled: controlsBusy,
    locale: form.values.uiLocale,
    onLocaleChange: form.setters.setUiLocale,
  };
}

function buildResearchPanelProps({
  controlsBusy,
  enginePanelProps,
  form,
  submit,
  test,
}: {
  controlsBusy: boolean;
  enginePanelProps: SettingsModalViewProps["enginePanelProps"];
  form: ReturnType<typeof useSettingsFormState>;
  submit: () => void;
  test: ReturnType<typeof useSettingsTestState>;
}): SettingsModalViewProps["researchPanelProps"] {
  const { values, setters } = form;
  return {
    ...enginePanelProps,
    controlsBusy,
    clearTestState: test.clearTestState,
    submit,
    apiBaseUrl: values.apiBaseUrl,
    apiKey: values.apiKey,
    apiVertexAuthMode: values.apiVertexAuthMode,
    apiVertexServiceAccountPath: values.apiVertexServiceAccountPath,
    apiKeyMaxAttempts: values.apiKeyMaxAttempts,
    apiRetryDelaySeconds: values.apiRetryDelaySeconds,
    setApiBaseUrl: setters.setApiBaseUrl,
    setApiKey: setters.setApiKey,
    setApiVertexAuthMode: setters.setApiVertexAuthMode,
    setApiVertexServiceAccountPath: setters.setApiVertexServiceAccountPath,
    setApiKeyMaxAttempts: setters.setApiKeyMaxAttempts,
    setApiRetryDelaySeconds: setters.setApiRetryDelaySeconds,
    researchTavilyAnalysisProvider: values.researchTavilyAnalysisProvider,
    researchGemmaPreset: values.researchGemmaPreset,
    researchGemmaReasoningEffort: values.researchGemmaReasoningEffort,
    researchGemmaMaxOutputTokens: values.researchGemmaMaxOutputTokens,
    researchGemmaContextTokens: values.researchGemmaContextTokens,
    researchApiModel: values.researchApiModel,
    researchApiMaxOutputTokens: values.researchApiMaxOutputTokens,
    researchApiContextTokens: values.researchApiContextTokens,
    researchCodexModel: values.researchCodexModel,
    researchCodexReasoningEffort: values.researchCodexReasoningEffort,
    researchCodexMaxOutputTokens: values.researchCodexMaxOutputTokens,
    researchCodexContextTokens: values.researchCodexContextTokens,
    tavilyApiKey: values.tavilyApiKey,
    tavilyMaxCreditsPerRun: values.tavilyMaxCreditsPerRun,
    setResearchTavilyAnalysisProvider:
      setters.setResearchTavilyAnalysisProvider,
    setResearchGemmaPreset: setters.setResearchGemmaPreset,
    setResearchGemmaReasoningEffort: setters.setResearchGemmaReasoningEffort,
    setResearchGemmaMaxOutputTokens: setters.setResearchGemmaMaxOutputTokens,
    setResearchGemmaContextTokens: setters.setResearchGemmaContextTokens,
    setResearchApiModel: setters.setResearchApiModel,
    setResearchApiMaxOutputTokens: setters.setResearchApiMaxOutputTokens,
    setResearchApiContextTokens: setters.setResearchApiContextTokens,
    setResearchCodexModel: setters.setResearchCodexModel,
    setResearchCodexReasoningEffort: setters.setResearchCodexReasoningEffort,
    setResearchCodexMaxOutputTokens: setters.setResearchCodexMaxOutputTokens,
    setResearchCodexContextTokens: setters.setResearchCodexContextTokens,
    setTavilyApiKey: setters.setTavilyApiKey,
    setTavilyMaxCreditsPerRun: setters.setTavilyMaxCreditsPerRun,
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
    detectedGpuName: runtime.gpuName,
    gpuMemoryMb: runtime.gpuMemoryMb,
    isLlamaRuntimeOptionDisabled: runtime.isLlamaRuntimeOptionDisabled,
    localModelInputRef: refs.localModelInputRef,
    modelRepoInputRef: refs.modelRepoInputRef,
    pickLocalMmprojFile: localActions.pickLocalMmprojFile,
    pickLocalModelFile: localActions.pickLocalModelFile,
    submit,
    usesAmdHardware: runtime.usesAmdHardware,
    usesAppleHardware: runtime.usesAppleHardware,
    usesNvidiaHardware: runtime.usesNvidiaHardware,
    usesRtx50Hardware: runtime.usesRtx50Hardware,
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
  form: ReturnType<typeof useSettingsFormState>;
  runtime: SettingsRuntimeGuards;
  test: ReturnType<typeof useSettingsTestState>;
}): SettingsModalViewProps["hardwarePanelProps"] {
  return {
    clearTestState: test.clearTestState,
    computeGpuIndex: form.values.computeGpuIndex,
    controlsBusy,
    detectedGpuName: runtime.gpuName,
    gpuMemoryMb: runtime.gpuMemoryMb,
    fluxBackend: form.values.fluxBackend,
    graphicsGpuPreference: form.values.graphicsGpuPreference,
    allowUnsafeLowMemoryFlux: form.values.allowUnsafeLowMemoryFlux,
    inpaintingModel: form.values.inpaintingModel,
    isFluxBackendOptionDisabled: runtime.isFluxBackendOptionDisabled,
    ocrDevice: form.values.ocrDevice,
    ocrGpuBackend: form.values.ocrGpuBackend,
    ocrQualityMode: form.values.ocrQualityMode,
    setFluxBackend: form.setters.setFluxBackend,
    setGraphicsGpuPreference: form.setters.setGraphicsGpuPreference,
    setComputeGpuIndex: form.setters.setComputeGpuIndex,
    setAllowUnsafeLowMemoryFlux: form.setters.setAllowUnsafeLowMemoryFlux,
    setInpaintingModel: form.setters.setInpaintingModel,
    setOcrDevice: form.setters.setOcrDevice,
    setOcrGpuBackend: form.setters.setOcrGpuBackend,
    setOcrQualityMode: form.setters.setOcrQualityMode,
    supportsOcrRocm: runtime.supportsOcrRocm,
    supportsFluxZluda: runtime.supportsFluxZluda,
    usesAmdHardware: runtime.usesAmdHardware,
    usesAppleHardware: runtime.usesAppleHardware,
    usesAmdOcrContext: runtime.usesAmdOcrContext,
    usesNvidiaHardware: runtime.usesNvidiaHardware,
    usesNvidiaOcrContext: runtime.usesNvidiaOcrContext,
    unifiedMemoryMb: runtime.unifiedMemoryMb,
    usesSm75Hardware: runtime.usesSm75Hardware,
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
    contextTokensValid: draft.contextTokensValid,
    maxTokensValid: draft.maxTokensValid,
    modelProvider: values.modelProvider,
    sourceLanguageValid: draft.sourceLanguageValid,
    targetLanguageValid: draft.targetLanguageValid,
  };
}
