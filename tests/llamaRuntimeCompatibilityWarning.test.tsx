/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LlamaRuntimeCompatibilityWarning } from "../src/renderer/src/components/settingsModal/LlamaRuntimeCompatibilityWarning";

afterEach(cleanup);

describe("LlamaRuntimeCompatibilityWarning", () => {
  it("shows the detected RTX 50 GPU when CUDA 12 is selected", () => {
    render(
      <LlamaRuntimeCompatibilityWarning
        detectedGpuName="NVIDIA GeForce RTX 5090"
        llamaRuntimeProfile="cuda12"
        usesNvidiaHardware
        usesRtx50Hardware
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "NVIDIA GeForce RTX 5090",
    );
  });

  it("uses the unknown-GPU label for an RTX 50 runtime mismatch", () => {
    render(
      <LlamaRuntimeCompatibilityWarning
        detectedGpuName={null}
        llamaRuntimeProfile="rtx50"
        usesNvidiaHardware
        usesRtx50Hardware={false}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "GPU 정보를 확인하지 못함",
    );
  });

  it("renders nothing for a compatible runtime", () => {
    const { container } = render(
      <LlamaRuntimeCompatibilityWarning
        detectedGpuName="NVIDIA GeForce RTX 4090"
        llamaRuntimeProfile="cuda12"
        usesNvidiaHardware
        usesRtx50Hardware={false}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});
