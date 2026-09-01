import React from "react";
import type {
  AppSettings,
  FluxBackend,
  LlamaRuntimeProfile,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../../../shared/settingsTypes";
import { isFluxRtx20Sm75Hardware } from "../../../../shared/fluxSm75";
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
import type { SettingsFormValues } from "./settingsModalFormValues";
import { isRtx50Hardware } from "./llamaRuntimeCompatibility";

export type SettingsRuntimeGuards = {
  gpuName: string | null;
  gpuMemoryMb: number | null;
  usesAmdHardware: boolean;
  usesNvidiaHardware: boolean;
  usesRtx50Hardware: boolean;
  usesSm75Hardware: boolean;
  supportsOcrRocm: boolean | undefined;
  supportsFluxZluda: boolean | undefined;
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
    initialSettings.runtimeHardware,
  );

  useSettingsFocusEffect(values, refs);
  useOcrRuntimeGuard(values, setters, runtime);
  useLlamaRuntimeGuard(values, setters, initialSettings, runtime);
  useFluxBackendGuard(values, setters, initialSettings, runtime);

  return {
    gpuName: initialSettings.runtimeHardware?.gpuName ?? null,
    gpuMemoryMb: initialSettings.runtimeHardware?.gpuMemoryMb ?? null,
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
        controlsBusy || isFluxBackendIncompatible(backend, runtime),
      [controlsBusy, runtime],
    ),
  };
}

function resolveRuntimeContext(
  values: SettingsFormValues,
  hardwareRuntimeLock: "amd" | "nvidia" | "apple" | "unknown",
  hardware: AppSettings["runtimeHardware"],
) {
  const detected = resolveDetectedRuntimeContext(hardwareRuntimeLock, hardware);
  const { usesAmdHardware, usesNvidiaHardware } = detected;
  const usesAmdGemmaRuntime =
    values.modelProvider === "gemma" &&
    isAmdLlamaRuntimeProfile(values.llamaRuntimeProfile);
  const usesNvidiaGemmaRuntime =
    values.modelProvider === "gemma" &&
    isNvidiaLlamaRuntimeProfile(values.llamaRuntimeProfile);
  const usesAmdOcrContext = usesAmdHardware || usesAmdGemmaRuntime;
  return {
    ...detected,
    usesAmdOcrContext,
    usesNvidiaOcrContext:
      usesNvidiaHardware || (!usesAmdOcrContext && usesNvidiaGemmaRuntime),
  };
}

function resolveDetectedRuntimeContext(
  hardwareRuntimeLock: "amd" | "nvidia" | "apple" | "unknown",
  hardware: AppSettings["runtimeHardware"],
) {
  const hardwareFlags = resolveDetectedHardwareFlags(hardwareRuntimeLock);
  const nvidiaFeatures = resolveNvidiaFeatureFlags(
    hardwareFlags.usesNvidiaHardware,
    hardware,
  );
  return {
    ...hardwareFlags,
    ...nvidiaFeatures,
    supportsOcrRocm: hardware?.supportsOcrRocm,
    supportsFluxZluda: hardware?.supportsFluxZluda,
    unifiedMemoryMb: hardware?.unifiedMemoryMb ?? null,
  };
}

function resolveDetectedHardwareFlags(
  hardwareRuntimeLock: "amd" | "nvidia" | "apple" | "unknown",
) {
  return {
    usesAmdHardware: hardwareRuntimeLock === "amd",
    usesNvidiaHardware: hardwareRuntimeLock === "nvidia",
    usesAppleHardware: hardwareRuntimeLock === "apple",
  };
}

export function resolveNvidiaFeatureFlags(
  usesNvidiaHardware: boolean,
  hardware: AppSettings["runtimeHardware"],
) {
  if (!usesNvidiaHardware) {
    return { usesRtx50Hardware: false, usesSm75Hardware: false };
  }
  const computeCapability = hardware?.computeCapability ?? null;
  const rtxGeneration = hardware?.rtxGeneration ?? null;
  return {
    usesRtx50Hardware: isRtx50Hardware(computeCapability, rtxGeneration),
    usesSm75Hardware: isFluxRtx20Sm75Hardware({
      computeCapability,
      rtxGeneration,
    }),
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

function useOcrRuntimeGuard(
  values: SettingsFormValues,
  setters: SettingsFormSetters,
  runtime: ReturnType<typeof resolveRuntimeContext>,
): void {
  React.useEffect(() => {
    const corrected = resolveCompatibleOcrSettings(
      {
        ocrDevice: values.ocrDevice,
        ocrGpuBackend: values.ocrGpuBackend,
        ocrQualityMode: values.ocrQualityMode,
      },
      {
        supportsOcrRocm: runtime.supportsOcrRocm,
        usesAmdOcrContext: runtime.usesAmdOcrContext,
        usesNvidiaOcrContext: runtime.usesNvidiaOcrContext,
      },
    );
    if (corrected.ocrDevice !== values.ocrDevice) {
      setters.setOcrDevice(corrected.ocrDevice);
    }
    if (corrected.ocrGpuBackend !== values.ocrGpuBackend) {
      setters.setOcrGpuBackend(corrected.ocrGpuBackend);
    }
    if (corrected.ocrQualityMode !== values.ocrQualityMode) {
      setters.setOcrQualityMode(corrected.ocrQualityMode);
    }
  }, [
    runtime.usesAmdOcrContext,
    runtime.usesNvidiaOcrContext,
    runtime.supportsOcrRocm,
    setters,
    values.ocrDevice,
    values.ocrGpuBackend,
    values.ocrQualityMode,
  ]);
}

type OcrRuntimeSettings = {
  ocrDevice: OcrDevice;
  ocrGpuBackend: OcrGpuBackend;
  ocrQualityMode: OcrQualityMode;
};

export function resolveCompatibleOcrSettings(
  values: OcrRuntimeSettings,
  _runtime: Pick<
    ReturnType<typeof resolveRuntimeContext>,
    "supportsOcrRocm" | "usesAmdOcrContext" | "usesNvidiaOcrContext"
  >,
): OcrRuntimeSettings {
  return {
    ...values,
    // GPU-only full quality must never remain paired with the CPU device.
    ocrQualityMode:
      values.ocrDevice === "cpu" && values.ocrQualityMode === "full"
        ? "economy"
        : values.ocrQualityMode,
  };
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
      runtime.usesSm75Hardware,
    );
    if (corrected !== values.fluxBackend) {
      setters.setFluxBackend(corrected);
    }
  }, [
    initialSettings.inpainting?.fluxBackend,
    runtime.usesAmdHardware,
    runtime.usesAppleHardware,
    runtime.usesNvidiaHardware,
    runtime.usesSm75Hardware,
    setters,
    values.fluxBackend,
  ]);
}

export function resolveCompatibleFluxBackend(
  backend: FluxBackend,
  initialBackend: FluxBackend | undefined,
  usesAmdHardware: boolean,
  usesAppleHardware: boolean,
  usesNvidiaHardware: boolean,
  usesSm75Hardware: boolean,
): FluxBackend {
  if (usesAppleHardware) return "metal-native";
  if (usesNvidiaHardware) {
    if (backend === "cpu-native") return backend;
    return usesSm75Hardware ? "cuda-sm75-experimental" : "cuda-native";
  }
  if (!usesAmdHardware) return backend;
  if (backend === "cpu-native" || backend === "zluda-native") return backend;
  return initialBackend === "cpu-native" ? "cpu-native" : "zluda-native";
}

function isNvidiaCudaFluxBackend(backend: FluxBackend): boolean {
  return backend === "cuda-native" || backend === "cuda-sm75-experimental";
}

export function isFluxBackendIncompatible(
  backend: FluxBackend,
  runtime: ReturnType<typeof resolveRuntimeContext>,
): boolean {
  if (runtime.usesAppleHardware) return backend !== "metal-native";
  if (backend === "metal-native") {
    return runtime.usesAmdHardware || runtime.usesNvidiaHardware;
  }
  if (runtime.usesAmdHardware) return isNvidiaCudaFluxBackend(backend);
  if (runtime.usesNvidiaHardware) {
    if (backend === "zluda-native") return true;
    if (backend === "cuda-native") return runtime.usesSm75Hardware;
    if (backend === "cuda-sm75-experimental") {
      return !runtime.usesSm75Hardware;
    }
    return false;
  }
  return backend === "cuda-sm75-experimental";
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
