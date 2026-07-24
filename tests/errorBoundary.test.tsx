/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";

const gatewayMocks = {
  writeLog: vi.fn(),
  prepareErrorReport: vi.fn(),
  copyErrorReport: vi.fn(),
  openErrorReportIssue: vi.fn(),
  openLogFolder: vi.fn(),
  restartApp: vi.fn(),
};

import { ErrorBoundary } from "../src/renderer/src/components/ErrorBoundary";

function BrokenView(): React.JSX.Element {
  throw new Error("renderer exploded");
}

describe("ErrorBoundary reporting", () => {
  beforeEach(() => {
    window.mangaApi = createTestMangaGatewayStub(gatewayMocks);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    gatewayMocks.writeLog.mockResolvedValue({ logged: true });
    gatewayMocks.prepareErrorReport.mockResolvedValue({
      defaultTitle: "[Bug] Renderer component crashed",
      errorMarkdown: "## Error\n\nrenderer exploded",
      systemMarkdown: "## System information",
      logsMarkdown: "## Recent warnings and errors",
      redactionCount: 0,
      truncated: false,
    });
    gatewayMocks.copyErrorReport.mockResolvedValue({ copied: true });
    gatewayMocks.openErrorReportIssue.mockResolvedValue({
      opened: true,
      mode: "prefilled",
    });
    gatewayMocks.openLogFolder.mockResolvedValue({ opened: true });
    gatewayMocks.restartApp.mockResolvedValue({ restarting: true });
  });

  afterEach(() => {
    cleanup();
    window.mangaApi = createTestMangaGatewayStub();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("logs the React stack and opens the fatal report dialog", async () => {
    render(
      <ErrorBoundary>
        <BrokenView />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "문제가 발생했어요",
    );
    expect(
      await screen.findByRole("dialog", { name: "앱 오류 보고" }),
    ).toBeTruthy();
    await waitFor(() => expect(gatewayMocks.writeLog).toHaveBeenCalledOnce());
    expect(gatewayMocks.writeLog).toHaveBeenCalledWith(
      "error",
      "렌더러 화면 오류",
      expect.objectContaining({
        message: "renderer exploded",
        stack: expect.stringContaining("renderer exploded"),
        componentStack: expect.stringContaining("BrokenView"),
      }),
    );
    expect(gatewayMocks.prepareErrorReport).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "react-boundary",
        message: "renderer exploded",
        componentStack: expect.stringContaining("BrokenView"),
      }),
    );
  });
});
