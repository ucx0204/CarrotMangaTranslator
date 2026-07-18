/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
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
});
