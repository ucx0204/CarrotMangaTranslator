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
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { RuntimeHardwareNote } from "../src/renderer/src/components/settingsModal/GemmaMemorySummary";
import {
  AmdHipSdkDownloadButton,
  FluxHardwareContextNote,
} from "../src/renderer/src/components/settingsModal/HardwareContextNotes";
import { resolveHardwareRecommendation } from "../src/renderer/src/components/settingsModal/hardwareRecommendation";
import { OCR_FULL_RECOMMENDED_GPU_MEMORY_MB } from "../src/shared/ocrMemoryPolicy";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("HardwareSettingsPanel", () => {
  it("separates the auto-detected GPU from a manually selected runtime device", () => {
    render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={vi.fn()}
        computeGpuIndex={1}
        controlsBusy={false}
        detectedGpuName="AMD Radeon RX 7600M XT"
        fluxBackend="cpu-native"
        gpuMemoryMb={8192}
        graphicsGpuPreference="high-performance"
        inpaintingModel="lama-manga"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="cpu"
        ocrGpuBackend="cuda"
        ocrPipeline="paddle-legacy"
        ocrQualityMode="economy"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setComputeGpuIndex={vi.fn()}
        setGraphicsGpuPreference={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={vi.fn()}
        setOcrGpuBackend={vi.fn()}
        setOcrPipeline={vi.fn()}
        setOcrQualityMode={vi.fn()}
        supportsFluxZluda={false}
        supportsOcrRocm={false}
        usesAmdHardware
        usesAppleHardware={false}
        usesAmdOcrContext
        usesNvidiaHardware={false}
        usesNvidiaOcrContext={false}
        unifiedMemoryMb={null}
      />,
    );

    expect(screen.getByText("자동 감지 기준 GPU")).toBeTruthy();
    expect(screen.getByText("AMD Radeon RX 7600M XT")).toBeTruthy();
    expect(screen.getByText("로컬 AI 연산 장치")).toBeTruthy();
    expect(screen.getByText("장치 1 (수동)")).toBeTruthy();
    expect(
      screen.getByText("권장값과 다른 고급 설정이 있습니다."),
    ).toBeTruthy();
  });

  it("omits generic Flux runtime context notes outside Apple Silicon", () => {
    const openAmdHipSdkDownload = vi.fn().mockResolvedValue(undefined);
    window.mangaApi = createTestMangaGatewayStub({ openAmdHipSdkDownload });
    const { container, rerender } = render(
      <RuntimeHardwareNote usesAppleHardware={false} />,
    );
    expect(container.textContent).toBe("");

    rerender(<FluxHardwareContextNote usesAppleHardware={false} />);
    expect(container.textContent).toBe("");

    rerender(<FluxHardwareContextNote usesAppleHardware />);
    expect(container.textContent).toContain("Apple Silicon");

    rerender(<AmdHipSdkDownloadButton />);
    fireEvent.click(screen.getByRole("button"));
    expect(openAmdHipSdkDownload).toHaveBeenCalledOnce();
  });

  it("keeps OCR on CPU for detected AMD adapters outside the ROCm allowlist", () => {
    const unsupported = resolveHardwareRecommendation({
      gpuMemoryMb: 12 * 1024,
      supportsFluxZluda: false,
      supportsOcrRocm: false,
      unifiedMemoryMb: null,
      usesAmdHardware: true,
      usesAppleHardware: false,
      usesNvidiaHardware: false,
    });
    const supported = resolveHardwareRecommendation({
      gpuMemoryMb: 12 * 1024,
      supportsFluxZluda: true,
      supportsOcrRocm: true,
      unifiedMemoryMb: null,
      usesAmdHardware: true,
      usesAppleHardware: false,
      usesNvidiaHardware: false,
    });
    const manualUnknown = resolveHardwareRecommendation({
      gpuMemoryMb: 12 * 1024,
      unifiedMemoryMb: null,
      usesAmdHardware: true,
      usesAppleHardware: false,
      usesNvidiaHardware: false,
    });

    expect(unsupported).toMatchObject({
      fluxBackend: "cpu-native",
      inpaintingModel: "flux-klein",
      ocrDevice: "cpu",
      ocrGpuBackend: "cuda",
      ocrQualityMode: "economy",
    });
    expect(supported).toMatchObject({
      fluxBackend: "zluda-native",
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm-transformers",
      ocrQualityMode: "full",
    });
    expect(manualUnknown).toMatchObject({
      fluxBackend: "zluda-native",
      ocrDevice: "cpu",
      ocrGpuBackend: "cuda",
      ocrQualityMode: "economy",
    });
  });

  it("warns for officially unsupported AMD Flux hardware and offers CPU", () => {
    const setFluxBackend = vi.fn();
    const clearTestState = vi.fn();
    render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={clearTestState}
        computeGpuIndex={null}
        controlsBusy={false}
        detectedGpuName="AMD Radeon RX 6700 XT"
        fluxBackend="zluda-native"
        graphicsGpuPreference="high-performance"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="cpu"
        ocrGpuBackend="cuda"
        ocrPipeline="paddle-legacy"
        ocrQualityMode="economy"
        setFluxBackend={setFluxBackend}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setComputeGpuIndex={vi.fn()}
        setGraphicsGpuPreference={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={vi.fn()}
        setOcrGpuBackend={vi.fn()}
        setOcrPipeline={vi.fn()}
        setOcrQualityMode={vi.fn()}
        supportsFluxZluda={false}
        supportsOcrRocm={false}
        usesAmdHardware
        usesAppleHardware={false}
        usesAmdOcrContext
        usesNvidiaHardware={false}
        usesNvidiaOcrContext={false}
        unifiedMemoryMb={null}
      />,
    );

    const warning = screen.getByRole("alert");
    expect(warning.textContent).toContain("공식 지원 대상이 아닌 AMD GPU");
    expect(warning.textContent).toContain("AMD Radeon RX 6700 XT");
    fireEvent.click(
      within(warning).getByRole("button", { name: "CPU 백엔드로 전환" }),
    );
    expect(clearTestState).toHaveBeenCalledOnce();
    expect(setFluxBackend).toHaveBeenCalledWith("cpu-native");
  });

  it("recommends full OCR when the detected GPU meets the measured memory floor", () => {
    const base = {
      unifiedMemoryMb: null,
      usesAmdHardware: false,
      usesAppleHardware: false,
      usesNvidiaHardware: true,
      usesSm75Hardware: false,
    };

    expect(
      resolveHardwareRecommendation({ ...base, gpuMemoryMb: 24_564 })
        .ocrQualityMode,
    ).toBe("full");
    expect(
      resolveHardwareRecommendation({ ...base, gpuMemoryMb: 16_303 })
        .ocrQualityMode,
    ).toBe("full");
    expect(
      resolveHardwareRecommendation({ ...base, gpuMemoryMb: 8_192 })
        .ocrQualityMode,
    ).toBe("full");
    expect(
      resolveHardwareRecommendation({
        ...base,
        gpuMemoryMb: OCR_FULL_RECOMMENDED_GPU_MEMORY_MB,
      }).ocrQualityMode,
    ).toBe("full");
    expect(
      resolveHardwareRecommendation({
        ...base,
        gpuMemoryMb: OCR_FULL_RECOMMENDED_GPU_MEMORY_MB - 1,
      }).ocrQualityMode,
    ).toBe("economy");
    expect(
      resolveHardwareRecommendation({ ...base, gpuMemoryMb: null })
        .ocrQualityMode,
    ).toBe("economy");
    expect(
      resolveHardwareRecommendation({
        unifiedMemoryMb: 8 * 1024,
        usesAmdHardware: false,
        usesAppleHardware: true,
        usesNvidiaHardware: false,
      }).ocrQualityMode,
    ).toBe("economy");
    expect(
      resolveHardwareRecommendation({
        unifiedMemoryMb: null,
        usesAmdHardware: false,
        usesAppleHardware: false,
        usesNvidiaHardware: false,
      }).ocrQualityMode,
    ).toBe("economy");
  });

  it("disables every Flux backend while settings controls are busy", () => {
    render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={vi.fn()}
        computeGpuIndex={null}
        controlsBusy
        fluxBackend="cuda-native"
        graphicsGpuPreference="auto"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="gpu"
        ocrGpuBackend="cuda"
        ocrPipeline="paddle-legacy"
        ocrQualityMode="economy"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setComputeGpuIndex={vi.fn()}
        setGraphicsGpuPreference={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={vi.fn()}
        setOcrGpuBackend={vi.fn()}
        setOcrPipeline={vi.fn()}
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
        computeGpuIndex={null}
        controlsBusy={false}
        fluxBackend="cuda-native"
        graphicsGpuPreference="auto"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="gpu"
        ocrGpuBackend="cuda"
        ocrPipeline="paddle-legacy"
        ocrQualityMode="full"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setComputeGpuIndex={vi.fn()}
        setGraphicsGpuPreference={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={setOcrDevice}
        setOcrGpuBackend={vi.fn()}
        setOcrPipeline={vi.fn()}
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

  it("shows only the supported OCR quality presets", () => {
    const setOcrDevice = vi.fn();
    const setOcrGpuBackend = vi.fn();
    const setOcrQualityMode = vi.fn();
    render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={vi.fn()}
        computeGpuIndex={null}
        controlsBusy={false}
        fluxBackend="cuda-native"
        graphicsGpuPreference="auto"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="gpu"
        ocrGpuBackend="cuda"
        ocrPipeline="paddle-legacy"
        ocrQualityMode="economy"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setComputeGpuIndex={vi.fn()}
        setGraphicsGpuPreference={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={setOcrDevice}
        setOcrGpuBackend={setOcrGpuBackend}
        setOcrPipeline={vi.fn()}
        setOcrQualityMode={setOcrQualityMode}
        usesAmdHardware={false}
        usesAppleHardware={false}
        usesAmdOcrContext={false}
        usesNvidiaHardware
        usesNvidiaOcrContext
        unifiedMemoryMb={null}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "CUDA 레거시 풀로드" }),
    ).toBeNull();
    const ocrQualityGroup = screen.getByRole("group", {
      name: "Paddle OCR 품질",
    });
    expect(
      within(ocrQualityGroup).queryByRole("button", { name: /최소/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "풀로드" }));
    expect(setOcrDevice).toHaveBeenCalledWith("gpu");
    expect(setOcrGpuBackend).toHaveBeenCalledWith("cuda");
    expect(setOcrQualityMode).toHaveBeenCalledWith("full");
  });

  it("switches the new OCR pipeline independently from Paddle legacy controls", () => {
    const clearTestState = vi.fn();
    const setOcrDevice = vi.fn();
    const setOcrGpuBackend = vi.fn();
    const setOcrPipeline = vi.fn();
    const props: React.ComponentProps<typeof HardwareSettingsPanel> = {
      allowUnsafeLowMemoryFlux: false,
      clearTestState,
      computeGpuIndex: null,
      controlsBusy: false,
      fluxBackend: "cuda-native",
      graphicsGpuPreference: "auto",
      inpaintingModel: "flux-klein",
      isFluxBackendOptionDisabled: () => false,
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrPipeline: "hayai",
      ocrQualityMode: "full",
      setAllowUnsafeLowMemoryFlux: vi.fn(),
      setComputeGpuIndex: vi.fn(),
      setFluxBackend: vi.fn(),
      setGraphicsGpuPreference: vi.fn(),
      setInpaintingModel: vi.fn(),
      setOcrDevice,
      setOcrGpuBackend,
      setOcrPipeline,
      setOcrQualityMode: vi.fn(),
      supportsOcrRocm: false,
      unifiedMemoryMb: null,
      usesAmdHardware: false,
      usesAmdOcrContext: false,
      usesAppleHardware: false,
      usesNvidiaHardware: true,
      usesNvidiaOcrContext: true,
    };
    const { rerender } = render(<HardwareSettingsPanel {...props} />);
    const pipelineGroup = screen.getByRole("group", {
      name: "텍스트 영역 검출 방식",
    });

    expect(
      within(pipelineGroup)
        .getByRole("button", { name: "HayaiOCR" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("group", { name: "Paddle OCR 품질" })).toBeNull();
    fireEvent.click(
      within(pipelineGroup).getByRole("button", {
        name: "PaddleOCR",
      }),
    );
    expect(clearTestState).toHaveBeenCalledOnce();
    expect(setOcrPipeline).toHaveBeenCalledWith("paddle-legacy");
    expect(setOcrDevice).not.toHaveBeenCalled();

    rerender(<HardwareSettingsPanel {...props} ocrPipeline="paddle-legacy" />);
    expect(screen.getByRole("group", { name: "Paddle OCR 품질" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "HayaiOCR" }));
    expect(setOcrPipeline).toHaveBeenCalledWith("hayai");
    expect(setOcrDevice).not.toHaveBeenCalled();
    expect(setOcrGpuBackend).not.toHaveBeenCalled();

    rerender(
      <HardwareSettingsPanel {...props} ocrDevice="cpu" ocrPipeline="hayai" />,
    );
    fireEvent.click(screen.getByText("OCR 실행 장치 고급 설정"));
    const deviceGroup = screen.getByRole("group", { name: "OCR 장치" });
    const cpuButton = within(deviceGroup).getByRole("button", { name: "CPU" });
    expect(cpuButton.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/CPU로 HayaiOCR를 실행합니다/)).toBeTruthy();
    fireEvent.click(cpuButton);
    expect(setOcrDevice).toHaveBeenCalledWith("cpu");
    expect(setOcrGpuBackend).not.toHaveBeenCalled();

    rerender(
      <HardwareSettingsPanel
        {...props}
        ocrPipeline="paddle-legacy"
        usesAppleHardware
        usesNvidiaHardware={false}
        usesNvidiaOcrContext={false}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "HayaiOCR" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    rerender(
      <HardwareSettingsPanel
        {...props}
        ocrPipeline="hayai"
        usesAppleHardware
        usesNvidiaHardware={false}
        usesNvidiaOcrContext={false}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "HayaiOCR" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    rerender(
      <HardwareSettingsPanel
        {...props}
        ocrPipeline="paddle-legacy"
        usesNvidiaHardware={false}
        usesNvidiaOcrContext={false}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "HayaiOCR" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("does not expose full quality or selectable ROCm OCR on unsupported AMD hardware", () => {
    const setOcrDevice = vi.fn();
    const setOcrGpuBackend = vi.fn();
    const setOcrQualityMode = vi.fn();
    render(
      <HardwareSettingsPanel
        allowUnsafeLowMemoryFlux={false}
        clearTestState={vi.fn()}
        computeGpuIndex={null}
        controlsBusy={false}
        fluxBackend="zluda-native"
        graphicsGpuPreference="high-performance"
        inpaintingModel="flux-klein"
        isFluxBackendOptionDisabled={() => false}
        ocrDevice="cpu"
        ocrGpuBackend="cuda"
        ocrPipeline="paddle-legacy"
        ocrQualityMode="economy"
        setFluxBackend={vi.fn()}
        setAllowUnsafeLowMemoryFlux={vi.fn()}
        setComputeGpuIndex={vi.fn()}
        setGraphicsGpuPreference={vi.fn()}
        setInpaintingModel={vi.fn()}
        setOcrDevice={setOcrDevice}
        setOcrGpuBackend={setOcrGpuBackend}
        setOcrPipeline={vi.fn()}
        setOcrQualityMode={setOcrQualityMode}
        supportsOcrRocm={false}
        usesAmdHardware
        usesAppleHardware={false}
        usesAmdOcrContext
        usesNvidiaHardware={false}
        usesNvidiaOcrContext={false}
        unifiedMemoryMb={null}
      />,
    );

    expect(screen.queryByRole("button", { name: "풀로드" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "HayaiOCR" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    const rocmButton = screen.getByRole("button", {
      name: "AMD ROCm",
    }) as HTMLButtonElement;
    expect(rocmButton.disabled).toBe(true);
    fireEvent.click(rocmButton);
    expect(setOcrDevice).not.toHaveBeenCalled();
    expect(setOcrGpuBackend).not.toHaveBeenCalled();
    expect(setOcrQualityMode).not.toHaveBeenCalled();
  });

  it("allows SM75 instead of standard CUDA on RTX 20 and keeps it visible elsewhere", () => {
    const setFluxBackend = vi.fn();
    const props: React.ComponentProps<typeof HardwareSettingsPanel> = {
      allowUnsafeLowMemoryFlux: false,
      clearTestState: vi.fn(),
      computeGpuIndex: null,
      controlsBusy: false,
      fluxBackend: "cuda-native",
      graphicsGpuPreference: "auto",
      inpaintingModel: "flux-klein",
      isFluxBackendOptionDisabled: (backend) => backend === "cuda-native",
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrPipeline: "paddle-legacy",
      ocrQualityMode: "economy",
      setAllowUnsafeLowMemoryFlux: vi.fn(),
      setComputeGpuIndex: vi.fn(),
      setFluxBackend,
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
    };
    const { rerender } = render(<HardwareSettingsPanel {...props} />);
    const fluxGroup = screen.getByRole("group", {
      name: "Flux 인페인팅 백엔드",
    });

    expect(
      (
        within(fluxGroup).getByRole("button", {
          name: "NVIDIA CUDA",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const sm75Button = within(fluxGroup).getByRole("button", {
      name: "SM75 CUDA",
    }) as HTMLButtonElement;
    expect(sm75Button.disabled).toBe(false);
    fireEvent.click(sm75Button);
    expect(setFluxBackend).toHaveBeenCalledWith("cuda-sm75-experimental");

    rerender(
      <HardwareSettingsPanel {...props} fluxBackend="cuda-sm75-experimental" />,
    );
    expect(screen.getByRole("note").textContent).toContain(
      "RTX 20 시리즈 전용",
    );

    rerender(
      <HardwareSettingsPanel
        {...props}
        isFluxBackendOptionDisabled={(backend) =>
          backend === "cuda-sm75-experimental"
        }
      />,
    );
    expect(
      (
        within(fluxGroup).getByRole("button", {
          name: "NVIDIA CUDA",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        within(fluxGroup).getByRole("button", {
          name: "SM75 CUDA",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    rerender(
      <HardwareSettingsPanel
        {...props}
        fluxBackend="metal-native"
        usesAppleHardware
        usesNvidiaHardware={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "SM75 CUDA" })).toBeNull();
  });
});
