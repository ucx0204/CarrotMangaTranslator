import React from "react";
import type {
  AppSettings,
  FluxBackend,
  LlamaRuntimeProfile,
} from "../../../../shared/settingsTypes";
import {
  isAmdLlamaRuntimeProfile,
  isNvidiaLlamaRuntimeProfile,
  resolveHardwareRuntimeLock,
} from "../settingsModalHelpers";
import type {
  SettingsFormRefs,
  SettingsFormSetters,
} from "./useSettingsFormState";
import type { SettingsFormValues } from "./settingsModalFormUtils";

export type SettingsRuntimeGuards = {
  usesAmdHardware: boolean;
  usesNvidiaHardware: boolean;
  usesAmdOcrContext: boolean;
  usesNvidiaOcrContext: boolean;
  isLlamaRuntimeOptionDisabled: (profile: LlamaRuntimeProfile) => boolean;
  isFluxBackendOptionDisabled: (backend: FluxBackend) => boolean;
};

export function useSettingsRuntimeGuards({
  controlsBusy,
  initialSettings,
  refs,
  setters,
  values,
}: {
  controlsBusy: boolean;
  initialSettings: AppSettings;
  refs: SettingsFormRefs;
  setters: SettingsFormSetters;
  values: SettingsFormValues;
}): SettingsRuntimeGuards {
  const hardwareRuntimeLock = React.useMemo(
    () => resolveHardwareRuntimeLock(initialSettings),
    [initialSettings],
  );
  const runtime = resolveRuntimeContext(values, hardwareRuntimeLock);

  useSettingsFocusEffect(values, refs);
  useOcrBackendGuard(values, setters, runtime);
  useLlamaRuntimeGuard(values, setters, initialSettings, runtime);
  useFluxBackendGuard(values, setters, initialSettings, runtime);

  return {
    ...runtime,
    isLlamaRuntimeOptionDisabled: React.useCallback(
      (profile: LlamaRuntimeProfile) =>
        controlsBusy ||
        (runtime.usesAmdHardware && isNvidiaLlamaRuntimeProfile(profile)) ||
        (runtime.usesNvidiaHardware && isAmdLlamaRuntimeProfile(profile)),
      [controlsBusy, runtime.usesAmdHardware, runtime.usesNvidiaHardware],
    ),
    isFluxBackendOptionDisabled: React.useCallback(
      (backend: FluxBackend) =>
        controlsBusy ||
        (runtime.usesAmdHardware && backend === "cuda-native") ||
        (runtime.usesNvidiaHardware && backend === "zluda-native"),
      [controlsBusy, runtime.usesAmdHardware, runtime.usesNvidiaHardware],
    ),
  };
}

function resolveRuntimeContext(
  values: SettingsFormValues,
  hardwareRuntimeLock: "amd" | "nvidia" | "unknown",
) {
  const usesAmdHardware = hardwareRuntimeLock === "amd";
  const usesNvidiaHardware = hardwareRuntimeLock === "nvidia";
  const usesAmdGemmaRuntime =
    values.modelProvider === "gemma" &&
    isAmdLlamaRuntimeProfile(values.llamaRuntimeProfile);
  const usesNvidiaGemmaRuntime =
    values.modelProvider === "gemma" &&
    isNvidiaLlamaRuntimeProfile(values.llamaRuntimeProfile);
  const usesAmdOcrContext = usesAmdHardware || usesAmdGemmaRuntime;
  return {
    usesAmdHardware,
    usesNvidiaHardware,
    usesAmdOcrContext,
    usesNvidiaOcrContext:
      usesNvidiaHardware || (!usesAmdOcrContext && usesNvidiaGemmaRuntime),
  };
}

function useSettingsFocusEffect(
  values: SettingsFormValues,
  refs: SettingsFormRefs,
): void {
  React.useEffect(() => {
    if (values.modelProvider !== "gemma") {
      return;
    }
    if (values.modelSource === "local") {
      refs.localModelInputRef.current?.focus();
      refs.localModelInputRef.current?.select();
      return;
    }
    if (values.selectedPreset === "custom") {
      refs.modelRepoInputRef.current?.focus();
      refs.modelRepoInputRef.current?.select();
    }
  }, [
    refs.localModelInputRef,
    refs.modelRepoInputRef,
    values.modelProvider,
    values.modelSource,
    values.selectedPreset,
  ]);
}

function useOcrBackendGuard(
  values: SettingsFormValues,
  setters: SettingsFormSetters,
  runtime: ReturnType<typeof resolveRuntimeContext>,
): void {
  React.useEffect(() => {
    if (
      values.ocrDevice === "gpu" &&
      values.ocrGpuBackend === "cuda" &&
      runtime.usesAmdOcrContext
    ) {
      setters.setOcrGpuBackend("rocm-transformers");
      return;
    }
    if (
      values.ocrDevice === "gpu" &&
      values.ocrGpuBackend === "rocm-transformers" &&
      runtime.usesNvidiaOcrContext
    ) {
      setters.setOcrGpuBackend("cuda");
    }
  }, [
    runtime.usesAmdOcrContext,
    runtime.usesNvidiaOcrContext,
    setters,
    values.ocrDevice,
    values.ocrGpuBackend,
  ]);
}

function useLlamaRuntimeGuard(
  values: SettingsFormValues,
  setters: SettingsFormSetters,
  initialSettings: AppSettings,
  runtime: ReturnType<typeof resolveRuntimeContext>,
): void {
  React.useEffect(() => {
    if (
      runtime.usesAmdHardware &&
      isNvidiaLlamaRuntimeProfile(values.llamaRuntimeProfile)
    ) {
      setters.setLlamaRuntimeProfile(
        resolvePreferredAmdLlamaRuntime(initialSettings),
      );
      return;
    }
    if (
      runtime.usesNvidiaHardware &&
      isAmdLlamaRuntimeProfile(values.llamaRuntimeProfile)
    ) {
      setters.setLlamaRuntimeProfile(
        resolvePreferredNvidiaLlamaRuntime(initialSettings),
      );
    }
  }, [
    initialSettings,
    runtime.usesAmdHardware,
    runtime.usesNvidiaHardware,
    setters,
    values.llamaRuntimeProfile,
  ]);
}

function useFluxBackendGuard(
  values: SettingsFormValues,
  setters: SettingsFormSetters,
  initialSettings: AppSettings,
  runtime: ReturnType<typeof resolveRuntimeContext>,
): void {
  React.useEffect(() => {
    if (runtime.usesAmdHardware && values.fluxBackend === "cuda-native") {
      setters.setFluxBackend(
        initialSettings.inpainting?.fluxBackend === "python-cpu"
          ? "python-cpu"
          : "zluda-native",
      );
      return;
    }
    if (runtime.usesNvidiaHardware && values.fluxBackend === "zluda-native") {
      setters.setFluxBackend("cuda-native");
    }
  }, [
    initialSettings.inpainting?.fluxBackend,
    runtime.usesAmdHardware,
    runtime.usesNvidiaHardware,
    setters,
    values.fluxBackend,
  ]);
}

function resolvePreferredAmdLlamaRuntime(
  initialSettings: AppSettings,
): LlamaRuntimeProfile {
  const fallback = initialSettings.gemma.llamaRuntimeProfile ?? "rocm";
  return isAmdLlamaRuntimeProfile(fallback) ? fallback : "rocm";
}

function resolvePreferredNvidiaLlamaRuntime(
  initialSettings: AppSettings,
): LlamaRuntimeProfile {
  const fallback = initialSettings.gemma.llamaRuntimeProfile ?? "cuda12";
  return isNvidiaLlamaRuntimeProfile(fallback) ? fallback : "cuda12";
}
