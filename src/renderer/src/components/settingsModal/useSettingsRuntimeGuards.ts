import React from "react";
import type {
  AppSettings,
  FluxBackend,
  LlamaRuntimeProfile,
} from "../../../../shared/settingsTypes";
import {
  isAmdLlamaRuntimeProfile,
  isAppleLlamaRuntimeProfile,
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
  usesAppleHardware: boolean;
  unifiedMemoryMb: number | null;
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
  const runtime = resolveRuntimeContext(
    values,
    hardwareRuntimeLock,
    initialSettings.runtimeHardware?.unifiedMemoryMb ?? null,
  );

  useSettingsFocusEffect(values, refs);
  useOcrBackendGuard(values, setters, runtime);
  useOcrQualityDeviceGuard(values, setters);
  useLlamaRuntimeGuard(values, setters, initialSettings, runtime);
  useFluxBackendGuard(values, setters, initialSettings, runtime);

  return {
    ...runtime,
    isLlamaRuntimeOptionDisabled: React.useCallback(
      (profile: LlamaRuntimeProfile) =>
        controlsBusy ||
        (runtime.usesAppleHardware && !isAppleLlamaRuntimeProfile(profile)) ||
        ((runtime.usesAmdHardware || runtime.usesNvidiaHardware) &&
          isAppleLlamaRuntimeProfile(profile)) ||
        (runtime.usesAmdHardware && isNvidiaLlamaRuntimeProfile(profile)) ||
        (runtime.usesNvidiaHardware && isAmdLlamaRuntimeProfile(profile)),
      [
        controlsBusy,
        runtime.usesAmdHardware,
        runtime.usesAppleHardware,
        runtime.usesNvidiaHardware,
      ],
    ),
    isFluxBackendOptionDisabled: React.useCallback(
      (backend: FluxBackend) =>
        controlsBusy ||
        (runtime.usesAppleHardware && backend !== "metal-native") ||
        ((runtime.usesAmdHardware || runtime.usesNvidiaHardware) &&
          backend === "metal-native") ||
        (runtime.usesAmdHardware && backend === "cuda-native") ||
        (runtime.usesNvidiaHardware && backend === "zluda-native"),
      [
        controlsBusy,
        runtime.usesAmdHardware,
        runtime.usesAppleHardware,
        runtime.usesNvidiaHardware,
      ],
    ),
  };
}

function resolveRuntimeContext(
  values: SettingsFormValues,
  hardwareRuntimeLock: "amd" | "nvidia" | "apple" | "unknown",
  unifiedMemoryMb: number | null,
) {
  const usesAmdHardware = hardwareRuntimeLock === "amd";
  const usesNvidiaHardware = hardwareRuntimeLock === "nvidia";
  const usesAppleHardware = hardwareRuntimeLock === "apple";
  const usesAmdGemmaRuntime =
    values.modelProvider === "gemma" &&
    isAmdLlamaRuntimeProfile(values.llamaRuntimeProfile);
  const usesNvidiaGemmaRuntime =
    values.modelProvider === "gemma" &&
    isNvidiaLlamaRuntimeProfile(values.llamaRuntimeProfile);
  const usesAmdOcrContext = usesAmdHardware || usesAmdGemmaRuntime;
  return {
    usesAmdHardware,
    usesAppleHardware,
    usesNvidiaHardware,
    unifiedMemoryMb,
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
    if (runtime.usesAppleHardware && values.ocrDevice !== "cpu") {
      setters.setOcrDevice("cpu");
      return;
    }
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
    runtime.usesAppleHardware,
    runtime.usesNvidiaOcrContext,
    setters,
    values.ocrDevice,
    values.ocrGpuBackend,
  ]);
}

function useOcrQualityDeviceGuard(
  values: SettingsFormValues,
  setters: SettingsFormSetters,
): void {
  React.useEffect(() => {
    // 풀로드(PaddleOCR-VL) 품질은 CPU에서 못 쓸 만큼 느리므로 CPU 장치와
    // 조합되지 않도록 절약 품질로 강제한다.
    if (values.ocrDevice === "cpu" && values.ocrQualityMode === "full") {
      setters.setOcrQualityMode("economy");
    }
  }, [setters, values.ocrDevice, values.ocrQualityMode]);
}

function useLlamaRuntimeGuard(
  values: SettingsFormValues,
  setters: SettingsFormSetters,
  initialSettings: AppSettings,
  runtime: ReturnType<typeof resolveRuntimeContext>,
): void {
  React.useEffect(() => {
    if (
      runtime.usesAppleHardware &&
      !isAppleLlamaRuntimeProfile(values.llamaRuntimeProfile)
    ) {
      setters.setLlamaRuntimeProfile("metal");
      return;
    }
    if (
      runtime.usesAmdHardware &&
      (isNvidiaLlamaRuntimeProfile(values.llamaRuntimeProfile) ||
        isAppleLlamaRuntimeProfile(values.llamaRuntimeProfile))
    ) {
      setters.setLlamaRuntimeProfile(
        resolvePreferredAmdLlamaRuntime(initialSettings),
      );
      return;
    }
    if (
      runtime.usesNvidiaHardware &&
      (isAmdLlamaRuntimeProfile(values.llamaRuntimeProfile) ||
        isAppleLlamaRuntimeProfile(values.llamaRuntimeProfile))
    ) {
      setters.setLlamaRuntimeProfile(
        resolvePreferredNvidiaLlamaRuntime(initialSettings),
      );
    }
  }, [
    initialSettings,
    runtime.usesAmdHardware,
    runtime.usesAppleHardware,
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
    const corrected = resolveCompatibleFluxBackend(
      values.fluxBackend,
      initialSettings.inpainting?.fluxBackend,
      runtime.usesAmdHardware,
      runtime.usesAppleHardware,
      runtime.usesNvidiaHardware,
    );
    if (corrected !== values.fluxBackend) {
      setters.setFluxBackend(corrected);
    }
  }, [
    initialSettings.inpainting?.fluxBackend,
    runtime.usesAmdHardware,
    runtime.usesAppleHardware,
    runtime.usesNvidiaHardware,
    setters,
    values.fluxBackend,
  ]);
}

function resolveCompatibleFluxBackend(
  backend: FluxBackend,
  initialBackend: FluxBackend | undefined,
  usesAmdHardware: boolean,
  usesAppleHardware: boolean,
  usesNvidiaHardware: boolean,
): FluxBackend {
  if (usesAppleHardware) return "metal-native";
  if (usesNvidiaHardware) {
    return backend === "zluda-native" || backend === "metal-native"
      ? "cuda-native"
      : backend;
  }
  if (!usesAmdHardware) return backend;
  if (backend === "python-cpu" || backend === "zluda-native") return backend;
  return initialBackend === "python-cpu" ? "python-cpu" : "zluda-native";
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
