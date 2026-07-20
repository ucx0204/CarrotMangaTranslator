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
        bubbleDetectionMode="auto"
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
        setBubbleDetectionMode={vi.fn()}
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

  it("shows highest quality and restricts experimental SAM 3 to NVIDIA", () => {
    const setBubbleDetectionMode = vi.fn();
    render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        bubbleDetectionMode="quality"
        clearTestState={vi.fn()}
        controlsBusy={false}
        fluxBackend="metal-native"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="cpu"
        ocrGpuBackend="cuda"
        ocrQualityMode="minimum"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setBubbleDetectionMode={setBubbleDetectionMode}
        setInpaintingModel={vi.fn()}
        setOcrDevice={vi.fn()}
        setOcrGpuBackend={vi.fn()}
        setOcrQualityMode={vi.fn()}
        usesAmdHardware={false}
        usesAppleHardware
        usesAmdOcrContext={false}
        usesNvidiaHardware={false}
        usesNvidiaOcrContext={false}
        unifiedMemoryMb={24_576}
      />,
    );

    const highest = screen.getByRole("button", { name: "최고 품질" });
    const sam3 = screen.getByRole("button", { name: "SAM 3 실험" });
    expect(highest.getAttribute("aria-pressed")).toBe("true");
    expect((sam3 as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(highest);
    expect(setBubbleDetectionMode).toHaveBeenCalledWith("quality");
  });
});
