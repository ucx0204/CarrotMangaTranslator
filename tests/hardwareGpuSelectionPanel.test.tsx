/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HardwareSettingsPanel } from "../src/renderer/src/components/settingsModal/HardwareSettingsPanel";

afterEach(cleanup);

describe("HardwareSettingsPanel GPU selection", () => {
  it("publishes graphics and compute GPU select changes", () => {
    const clearTestState = vi.fn();
    const setGraphicsGpuPreference = vi.fn();
    const setComputeGpuIndex = vi.fn();

    renderPanel({
      clearTestState,
      setGraphicsGpuPreference,
      setComputeGpuIndex,
    });

    const selects = screen.getAllByRole<HTMLSelectElement>("combobox");
    expect(selects).toHaveLength(2);
    const graphicsSelect = selects.find((select) => select.value === "auto");
    const computeSelect = selects.find((select) => select.value === "");
    if (!graphicsSelect || !computeSelect) {
      throw new Error("Expected graphics and compute GPU selects");
    }

    fireEvent.change(graphicsSelect, {
      target: { value: "high-performance" },
    });
    fireEvent.change(computeSelect, { target: { value: "1" } });
    fireEvent.change(computeSelect, { target: { value: "" } });

    expect(setGraphicsGpuPreference).toHaveBeenCalledWith("high-performance");
    expect(setComputeGpuIndex).toHaveBeenNthCalledWith(1, 1);
    expect(setComputeGpuIndex).toHaveBeenNthCalledWith(2, null);
    expect(clearTestState).toHaveBeenCalledTimes(3);
  });

  it("disables both GPU selects while settings controls are busy", () => {
    renderPanel({ controlsBusy: true });

    const selects = screen.getAllByRole<HTMLSelectElement>("combobox");
    expect(selects).toHaveLength(2);
    expect(selects.every((select) => select.disabled)).toBe(true);
  });
});

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof HardwareSettingsPanel>> = {},
) {
  const props: React.ComponentProps<typeof HardwareSettingsPanel> = {
    allowUnsafeLowMemoryFlux: false,
    clearTestState: vi.fn(),
    computeGpuIndex: null,
    controlsBusy: false,
    fluxBackend: "cuda-native",
    graphicsGpuPreference: "auto",
    inpaintingModel: "flux-klein",
    isFluxBackendOptionDisabled: () => false,
    ocrDevice: "gpu",
    ocrGpuBackend: "cuda",
    ocrQualityMode: "minimum",
    setAllowUnsafeLowMemoryFlux: vi.fn(),
    setComputeGpuIndex: vi.fn(),
    setFluxBackend: vi.fn(),
    setGraphicsGpuPreference: vi.fn(),
    setInpaintingModel: vi.fn(),
    setOcrDevice: vi.fn(),
    setOcrGpuBackend: vi.fn(),
    setOcrQualityMode: vi.fn(),
    unifiedMemoryMb: null,
    usesAmdHardware: false,
    usesAmdOcrContext: false,
    usesAppleHardware: false,
    usesNvidiaHardware: true,
    usesNvidiaOcrContext: true,
    ...overrides,
  };
  return render(<HardwareSettingsPanel {...props} />);
}
