/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusDockButton } from "../src/renderer/src/components/StatusDockButton";
import type { JobState } from "../src/shared/jobTypes";

afterEach(cleanup);

describe("status dock", () => {
  it("shows unread state without forcing open and exposes the latest line", async () => {
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={["가장 최근", "이전 상태"]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "작업 센터 열기",
    });

    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
    await waitFor(() => expect(button.classList.contains("unread")).toBe(true));
    expect(button.getAttribute("title")).toBe("최근 상태: 가장 최근");
  });

  it("opens accessibly, clears history, and closes on Escape or outside click", () => {
    const onClear = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={["가장 최근", "이전 상태"]}
        onCancelJob={vi.fn()}
        onClear={onClear}
      />,
    );
    const button = screen.getByRole("button", {
      name: "작업 센터 열기",
    });
    fireEvent.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "작업 센터" })).not.toBeNull();
    expect(screen.getAllByText(/상태|최근/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "완료 알림음 켜기" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 기록 지우기" }));
    expect(onClear).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
  });

  it("starts muted and keeps the volume bar to the left of the speaker toggle", () => {
    const onChange = vi.fn();
    render(<SoundStatusDockHarness onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const slider = screen.getByRole("slider", {
      name: "완료 알림음 볼륨",
    });
    const unmute = screen.getByRole("button", { name: "완료 알림음 켜기" });

    expect((slider as HTMLInputElement).value).toBe("35");
    expect(slider.compareDocumentPosition(unmute)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(unmute.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(unmute);
    expect(onChange).toHaveBeenLastCalledWith({ muted: false, volume: 0.35 });
    expect(
      screen.getByRole("button", { name: "완료 알림음 음소거" }),
    ).not.toBeNull();

    fireEvent.change(slider, { target: { value: "72" } });
    expect(onChange).toHaveBeenLastCalledWith({ muted: false, volume: 0.72 });
  });

  it("keeps a failed job visibly red independently of unread history", () => {
    render(
      <StatusDockButton
        jobState={makeJobState({ status: "failed", detail: "raw failure" })}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={[]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "작업 센터 열기" })
        .classList.contains("failed"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    expect(screen.getByRole("log").textContent).toContain(
      "아직 표시할 상태가 없습니다.",
    );
  });

  it("keeps job progress and cancellation in the activity center", () => {
    const onCancelJob = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState({
          progressText: "OCR 처리 중",
          status: "running",
        })}
        progressSnapshot={{
          current: 2,
          mode: "determinate",
          ratio: 0.5,
          total: 4,
        }}
        showProgressBar
        statusLines={["2 / 4페이지"]}
        onCancelJob={onCancelJob}
        onClear={vi.fn()}
      />,
    );

    const dockButton = screen.getByRole("button", { name: "작업 센터 열기" });
    expect(dockButton.classList.contains("running")).toBe(true);
    expect(dockButton.querySelector(".status-dock-indicator")).not.toBeNull();
    expect(dockButton.querySelector(".status-dock-bell")).not.toBeNull();
    fireEvent.click(dockButton);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "2",
    );
    fireEvent.click(screen.getByRole("button", { name: "현재 작업 취소" }));
    expect(onCancelJob).toHaveBeenCalledOnce();
  });

  it("turns a completed translation into a result card with next actions", () => {
    const onReviewResults = vi.fn();
    const onOpenExport = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState({
          kind: "gemma-analysis",
          status: "completed",
          progressText: "3페이지 번역 완료",
          detail: "검토가 필요한 블록 1개가 있습니다.",
          pageTotal: 3,
        })}
        progressSnapshot={{
          current: 3,
          mode: "determinate",
          ratio: 1,
          total: 3,
        }}
        showProgressBar={false}
        statusLines={["3페이지 번역을 완료했습니다."]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
        onOpenExport={onOpenExport}
        onReviewResults={onReviewResults}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    expect(screen.getByText("작업이 완료됐습니다")).not.toBeNull();
    expect(screen.getByText("3페이지 처리 완료")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "결과 검토" }));
    expect(onReviewResults).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
    expect(onOpenExport).toHaveBeenCalledOnce();
  });

  it("loads older in-memory status rows in batches at the bottom", () => {
    const statusLines = Array.from(
      { length: 40 },
      (_, index) => `상태 기록 ${index + 1}`,
    );
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={statusLines}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const log = screen.getByRole("log");
    expect(log.classList.contains("scrollable")).toBe(true);
    expect(log.dataset.visibleLimit).toBe("5");
    expect(log.dataset.loadedCount).toBe("16");
    expect(log.childElementCount).toBe(16);
    expect(within(log).getByText("상태 기록 1")).not.toBeNull();
    expect(within(log).queryByText("상태 기록 17")).toBeNull();

    setScrollMetrics(log, { clientHeight: 200, scrollHeight: 800 });
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(log.childElementCount).toBe(16);

    log.scrollTop = 600;
    fireEvent.scroll(log);
    expect(log.dataset.loadedCount).toBe("32");
    expect(within(log).getByText("상태 기록 32")).not.toBeNull();
    expect(within(log).queryByText("상태 기록 33")).toBeNull();

    setScrollMetrics(log, { clientHeight: 200, scrollHeight: 1_600 });
    log.scrollTop = 1_400;
    fireEvent.scroll(log);
    expect(log.dataset.loadedCount).toBe("40");
    expect(within(log).getByText("상태 기록 40")).not.toBeNull();

    fireEvent.scroll(log);
    expect(log.childElementCount).toBe(40);
  });

  it("starts from the latest batch again after the session log is cleared", async () => {
    const commonProps = {
      jobState: makeJobState(),
      progressSnapshot: null,
      showProgressBar: false,
      onCancelJob: vi.fn(),
      onClear: vi.fn(),
    };
    const view = render(
      <StatusDockButton
        {...commonProps}
        statusLines={Array.from(
          { length: 40 },
          (_, index) => `기존 기록 ${index + 1}`,
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const log = screen.getByRole("log");
    setScrollMetrics(log, { clientHeight: 200, scrollHeight: 800 });
    log.scrollTop = 600;
    fireEvent.scroll(log);
    expect(log.dataset.loadedCount).toBe("32");

    view.rerender(<StatusDockButton {...commonProps} statusLines={[]} />);
    await waitFor(() => expect(log.dataset.loadedCount).toBe("0"));
    view.rerender(
      <StatusDockButton
        {...commonProps}
        statusLines={Array.from(
          { length: 24 },
          (_, index) => `새 기록 ${index + 1}`,
        )}
      />,
    );

    await waitFor(() => expect(log.dataset.loadedCount).toBe("16"));
    expect(within(log).queryByText("새 기록 17")).toBeNull();
  });

  it("offers page-level retry and the error report for failed work", () => {
    const onRetryPage = vi.fn();
    const onOpenErrorReport = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState({
          status: "failed",
          progressText: "일부 페이지 실패",
        })}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={["003.jpg 실패"]}
        failedPages={[
          { id: "page-3", name: "003.jpg", error: "OCR 시간 초과" },
        ]}
        onRetryPage={onRetryPage}
        onOpenErrorReport={onOpenErrorReport}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "오류 보고" }));
    expect(onOpenErrorReport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetryPage).toHaveBeenCalledWith("page-3");
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
  });

  it("keeps the previous terminal job in recent history", async () => {
    const commonProps = {
      progressSnapshot: null,
      showProgressBar: false,
      statusLines: ["새 작업 시작"],
      onCancelJob: vi.fn(),
      onClear: vi.fn(),
    };
    const view = render(
      <StatusDockButton
        {...commonProps}
        jobState={makeJobState({
          id: "job-completed",
          status: "completed",
          progressText: "이전 작업 완료",
          pageTotal: 9,
        })}
      />,
    );
    view.rerender(
      <StatusDockButton
        {...commonProps}
        jobState={makeJobState({
          id: "job-running",
          status: "running",
          progressText: "새 작업 진행 중",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    await waitFor(() =>
      expect(screen.getByText("이전 작업 완료")).not.toBeNull(),
    );
    expect(screen.getByText("9페이지 처리 완료")).not.toBeNull();
  });
});

function SoundStatusDockHarness({
  onChange,
}: {
  onChange: (preferences: { muted: boolean; volume: number }) => void;
}): React.JSX.Element {
  const [preferences, setPreferences] = React.useState({
    muted: true,
    volume: 0.35,
  });
  return (
    <StatusDockButton
      completionSoundMuted={preferences.muted}
      completionSoundVolume={preferences.volume}
      jobState={makeJobState()}
      progressSnapshot={null}
      showProgressBar={false}
      statusLines={[]}
      onCancelJob={vi.fn()}
      onClear={vi.fn()}
      onCompletionSoundChange={(next) => {
        setPreferences(next);
        onChange(next);
      }}
    />
  );
}

function makeJobState(overrides: Partial<JobState> = {}): JobState {
  return {
    id: "job-1",
    kind: "inpainting",
    progressText: "대기",
    status: "idle",
    ...overrides,
  };
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, value: 0, writable: true },
  });
}
