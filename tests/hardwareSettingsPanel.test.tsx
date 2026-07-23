/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HardwareSettingsPanel } from "../src/renderer/src/components/settingsModal/HardwareSettingsPanel";

afterEach(cleanup);

describe("HardwareSettingsPanel", () => {
  it("disables every Flux backend while settings controls are busy", () => {
    render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={vi.fn()}
        controlsBusy
        fluxBackend="cuda-native"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="gpu"
        ocrGpuBackend="cuda"
        ocrQualityMode="minimum"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={vi.fn()}
        setOcrGpuBackend={vi.fn()}
        setOcrQualityMode={vi.fn()}
        usesAmdHardware={false}
        usesAppleHardware={false}
        usesAmdOcrContext={false}
        usesNvidiaHardware
        usesNvidiaOcrContext
        unifiedMemoryMb={null}
      />,
    );

    const group = screen.getByRole("group", {
      name: "Flux 인페인팅 백엔드",
    });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    expect(
      buttons.every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it("does not silently change GPU OCR to CPU when quality changes", () => {
    const setOcrDevice = vi.fn();
    const setOcrQualityMode = vi.fn();
    render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={vi.fn()}
        controlsBusy={false}
        fluxBackend="cuda-native"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="gpu"
        ocrGpuBackend="cuda"
        ocrQualityMode="full"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={setOcrDevice}
        setOcrGpuBackend={vi.fn()}
        setOcrQualityMode={setOcrQualityMode}
        usesAmdHardware={false}
        usesAppleHardware={false}
        usesAmdOcrContext={false}
        usesNvidiaHardware
        usesNvidiaOcrContext
        unifiedMemoryMb={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "절약" }));

    expect(setOcrQualityMode).toHaveBeenCalledWith("economy");
    expect(setOcrDevice).not.toHaveBeenCalled();
  });

  it("shows CUDA legacy full only for NVIDIA OCR and selects the legacy path", () => {
    const setOcrDevice = vi.fn();
    const setOcrGpuBackend = vi.fn();
    const setOcrQualityMode = vi.fn();
    const { rerender } = render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={vi.fn()}
        controlsBusy={false}
        fluxBackend="cuda-native"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="gpu"
        ocrGpuBackend="cuda"
        ocrQualityMode="full"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={setOcrDevice}
        setOcrGpuBackend={setOcrGpuBackend}
        setOcrQualityMode={setOcrQualityMode}
        usesAmdHardware={false}
        usesAppleHardware={false}
        usesAmdOcrContext={false}
        usesNvidiaHardware
        usesNvidiaOcrContext
        unifiedMemoryMb={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "CUDA 레거시 풀로드" }));
    expect(setOcrDevice).toHaveBeenCalledWith("gpu");
    expect(setOcrGpuBackend).toHaveBeenCalledWith("cuda");
    expect(setOcrQualityMode).toHaveBeenCalledWith("cuda-legacy-full");

    rerender(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={vi.fn()}
        controlsBusy={false}
        fluxBackend="zluda-native"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="gpu"
        ocrGpuBackend="rocm-transformers"
        ocrQualityMode="full"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={vi.fn()}
        setOcrGpuBackend={vi.fn()}
        setOcrQualityMode={vi.fn()}
        usesAmdHardware
        usesAppleHardware={false}
        usesAmdOcrContext
        usesNvidiaHardware={false}
        usesNvidiaOcrContext={false}
        unifiedMemoryMb={null}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "CUDA 레거시 풀로드" }),
    ).toBeNull();
  });
});
