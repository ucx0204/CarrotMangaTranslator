/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HardwareSettingsPanel } from "../src/renderer/src/components/settingsModal/HardwareSettingsPanel";
import { chooseCustomSelectOption } from "./testUtils/customSelect";

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

    const selects = screen.getAllByRole<HTMLButtonElement>("combobox");
    expect(selects).toHaveLength(2);
    const graphicsSelect = selects.find((select) => select.value === "auto");
    const computeSelect = selects.find((select) => select.value === "");
    if (!graphicsSelect || !computeSelect) {
      throw new Error("Expected graphics and compute GPU selects");
    }

    chooseCustomSelectOption("앱 그래픽 GPU", "고성능 GPU 우선 (RTX/외장)");
    chooseCustomSelectOption(
      "로컬 AI 연산 GPU",
      "연산 장치 1 (CUDA/HIP/Vulkan)",
    );

    expect(setGraphicsGpuPreference).toHaveBeenCalledWith("high-performance");
    expect(setComputeGpuIndex).toHaveBeenNthCalledWith(1, 1);
    expect(clearTestState).toHaveBeenCalledTimes(2);

    cleanup();
    const clearAutomaticTestState = vi.fn();
    const setAutomaticComputeGpuIndex = vi.fn();
    renderPanel({
      clearTestState: clearAutomaticTestState,
      computeGpuIndex: 1,
      setComputeGpuIndex: setAutomaticComputeGpuIndex,
    });
    chooseCustomSelectOption("로컬 AI 연산 GPU", "자동 (권장)");
    expect(setAutomaticComputeGpuIndex).toHaveBeenCalledWith(null);
    expect(clearAutomaticTestState).toHaveBeenCalledOnce();
  });

  it("disables both GPU selects while settings controls are busy", () => {
    renderPanel({ controlsBusy: true });

    const selects = screen.getAllByRole<HTMLButtonElement>("combobox");
    expect(selects).toHaveLength(2);
    expect(selects.every((select) => select.disabled)).toBe(true);
  });

  it("keeps hardware choices intact on a Gemma reset failure and allows retry", async () => {
    const setComputeGpuIndex = vi.fn();
    const onApplyGemmaDefaults = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderPanel({ onApplyGemmaDefaults, setComputeGpuIndex });
      const apply = screen.getByRole("button", { name: "권장값 적용" });
      fireEvent.click(apply);
      await screen.findByRole("alert");
      expect(setComputeGpuIndex).not.toHaveBeenCalled();
      await waitFor(() => expect(apply).toHaveProperty("disabled", false));
      fireEvent.click(apply);
      await waitFor(() =>
        expect(setComputeGpuIndex).toHaveBeenCalledWith(null),
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(onApplyGemmaDefaults).toHaveBeenCalledTimes(2);
    } finally {
      report.mockRestore();
    }
  });

  it("applies recommendations for an existing AOT setup without a Gemma reset hook", async () => {
    const setInpaintingModel = vi.fn();
    const setComputeGpuIndex = vi.fn();
    const { container } = renderPanel({
      inpaintingModel: "aot-inpainting",
      setInpaintingModel,
      setComputeGpuIndex,
    });
    expect(container.textContent).toContain("AOT");
    fireEvent.click(screen.getByRole("button", { name: "권장값 적용" }));
    await waitFor(() => expect(setComputeGpuIndex).toHaveBeenCalledWith(null));
    expect(setInpaintingModel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
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
    ocrPipeline: "paddle-legacy",
    ocrQualityMode: "economy",
    setAllowUnsafeLowMemoryFlux: vi.fn(),
    setComputeGpuIndex: vi.fn(),
    setFluxBackend: vi.fn(),
    setGraphicsGpuPreference: vi.fn(),
    setInpaintingModel: vi.fn(),
    setOcrDevice: vi.fn(),
    setOcrGpuBackend: vi.fn(),
    setOcrPipeline: vi.fn(),
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
