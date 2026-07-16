/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ErrorReportContext,
  ErrorReportDraft,
} from "../src/shared/errorReportTypes";

const gatewayMocks = vi.hoisted(() => ({
  prepareErrorReport: vi.fn(),
  copyErrorReport: vi.fn(),
  openErrorReportIssue: vi.fn(),
  openLogFolder: vi.fn(),
}));

vi.mock("../src/renderer/src/api/mangaGateway", () => ({
  mangaGateway: {
    ...gatewayMocks,
  },
}));

import { ErrorReportDialog } from "../src/renderer/src/components/ErrorReportDialog";

const CONTEXT: ErrorReportContext = {
  source: "manual",
  summary: "번역 작업 실패",
  message: "모델 응답 오류",
  stack: "Error: 모델 응답 오류\n    at <app>\\renderer.js:10:4",
  jobStage: "translate",
};

const DRAFT: ErrorReportDraft = {
  defaultTitle: "[Bug] 번역 작업 실패",
  errorMarkdown: "## 오류\n\n모델 응답 오류",
  systemMarkdown: "## 시스템\n\n- App: 1.5.0\n- Windows: 11",
  logsMarkdown: "## 최근 오류 로그\n\n```text\n[ERROR] request failed\n```",
  redactionCount: 3,
  truncated: false,
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  gatewayMocks.prepareErrorReport.mockResolvedValue(DRAFT);
  gatewayMocks.copyErrorReport.mockResolvedValue({ copied: true });
  gatewayMocks.openErrorReportIssue.mockResolvedValue({
    opened: true,
    mode: "prefilled",
  });
  gatewayMocks.openLogFolder.mockResolvedValue({ opened: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("ErrorReportDialog", () => {
  it("exposes an accessible editable report and defaults diagnostics on", async () => {
    render(<ErrorReportDialog context={CONTEXT} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "오류 보고" })).toBeTruthy();
    expect(
      screen.getByText(/GitHub 이슈는 누구나 볼 수 있습니다/),
    ).toBeTruthy();

    const title = await screen.findByDisplayValue("[Bug] 번역 작업 실패");
    const description = screen.getByLabelText("오류 직전에 무엇을 했나요?");
    const systemToggle = screen.getByRole("checkbox", {
      name: "앱, Windows, 하드웨어 정보 포함",
    }) as HTMLInputElement;
    const logsToggle = screen.getByRole("checkbox", {
      name: "정제된 최근 오류 로그 포함",
    }) as HTMLInputElement;
    const preview = screen.getByLabelText(
      "GitHub에 공유할 Markdown 미리보기",
    ) as HTMLTextAreaElement;

    expect(title).toHaveProperty("required", true);
    expect(systemToggle.checked).toBe(true);
    expect(logsToggle.checked).toBe(true);
    expect(preview.readOnly).toBe(true);
    expect(preview.value).toContain("## 오류");
    expect(preview.value).toContain("## 시스템");
    expect(preview.value).toContain("## 최근 오류 로그");
    expect(preview.value).toContain("마스킹된 항목: 3개");

    fireEvent.change(description, {
      target: { value: "번역 버튼을 눌렀습니다." },
    });
    fireEvent.click(systemToggle);
    fireEvent.click(logsToggle);

    expect(preview.value).toContain("번역 버튼을 눌렀습니다.");
    expect(preview.value).not.toContain("## 시스템");
    expect(preview.value).not.toContain("## 최근 오류 로그");
  });

  it("runs copy, GitHub, log, close, and fatal restart actions", async () => {
    const onClose = vi.fn();
    const onRestart = vi.fn().mockResolvedValue(undefined);
    render(
      <ErrorReportDialog
        context={CONTEXT}
        onClose={onClose}
        fatal
        onRestart={onRestart}
      />,
    );
    await screen.findByDisplayValue("[Bug] 번역 작업 실패");

    fireEvent.change(screen.getByLabelText("오류 직전에 무엇을 했나요?"), {
      target: { value: "설정 저장 직후" },
    });
    fireEvent.click(screen.getByRole("button", { name: "진단 정보 복사" }));
    await waitFor(() =>
      expect(gatewayMocks.copyErrorReport).toHaveBeenCalledOnce(),
    );
    expect(gatewayMocks.copyErrorReport.mock.calls[0]?.[0]).toContain(
      "설정 저장 직후",
    );
    expect(
      await screen.findByText("진단 정보를 클립보드에 복사했습니다."),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "GitHub에서 이슈 작성" }),
    );
    await waitFor(() =>
      expect(gatewayMocks.openErrorReportIssue).toHaveBeenCalledOnce(),
    );
    expect(gatewayMocks.openErrorReportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "[Bug] 번역 작업 실패",
        body: expect.stringContaining("## 오류"),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "로그 폴더 열기" }));
    await waitFor(() =>
      expect(gatewayMocks.openLogFolder).toHaveBeenCalledOnce(),
    );

    fireEvent.click(screen.getByRole("button", { name: "앱 다시 시작" }));
    await waitFor(() => expect(onRestart).toHaveBeenCalledOnce());

    const closeButtons = screen.getAllByRole("button", { name: "닫기" });
    fireEvent.click(closeButtons.at(-1) as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("explains the clipboard fallback for an oversized GitHub URL", async () => {
    gatewayMocks.openErrorReportIssue.mockResolvedValue({
      opened: true,
      mode: "clipboard",
    });
    render(<ErrorReportDialog context={CONTEXT} onClose={vi.fn()} />);
    await screen.findByDisplayValue("[Bug] 번역 작업 실패");

    fireEvent.click(
      screen.getByRole("button", { name: "GitHub에서 이슈 작성" }),
    );

    expect(
      await screen.findByText(
        "내용이 길어 클립보드에 복사했습니다. 열린 GitHub 이슈에 붙여넣어 주세요.",
      ),
    ).toBeTruthy();
  });

  it("blocks duplicate actions and keeps failures visible for retry", async () => {
    const pendingCopy = createDeferred<unknown>();
    gatewayMocks.copyErrorReport.mockReturnValue(pendingCopy.promise);
    render(<ErrorReportDialog context={CONTEXT} onClose={vi.fn()} />);
    await screen.findByDisplayValue("[Bug] 번역 작업 실패");

    const copyButton = screen.getByRole("button", {
      name: "진단 정보 복사",
    });
    fireEvent.click(copyButton);
    fireEvent.click(copyButton);

    expect(gatewayMocks.copyErrorReport).toHaveBeenCalledOnce();
    expect(copyButton).toHaveProperty("disabled", true);

    pendingCopy.reject(new Error("clipboard unavailable"));
    expect(
      await screen.findByText(
        "진단 정보를 복사하지 못했습니다. 다시 시도해 주세요.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(copyButton).toHaveProperty("disabled", false));
  });

  it("does not expose raw details when diagnostic preparation fails", async () => {
    gatewayMocks.prepareErrorReport.mockRejectedValueOnce(
      new Error("raw secret: sk-test"),
    );
    render(<ErrorReportDialog context={CONTEXT} onClose={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "안전한 진단 정보를 준비하지 못했습니다.",
    );
    expect(document.body.textContent).not.toContain("sk-test");
    expect(
      screen.getByRole("button", { name: "GitHub에서 이슈 작성" }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(
      await screen.findByDisplayValue("[Bug] 번역 작업 실패"),
    ).toBeTruthy();
    expect(gatewayMocks.prepareErrorReport).toHaveBeenCalledTimes(2);
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
